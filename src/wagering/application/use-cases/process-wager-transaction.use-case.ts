import { InboxMessage } from "../../domain/entities/inbox-message.entity";
import {
  INTERNAL_PROVIDER_ID,
  WagerTransaction,
  WagerTransactionKind,
} from "../../domain/entities/wager-transaction.entity";
import { computePayloadHash } from "../../domain/services/payload-hash.service";
import { settleTransaction } from "../../domain/services/settle-transaction.service";
import { Money, type MoneyProps } from "../../domain/value-objects/money.vo";
import {
  IdempotencyConflictError,
  InvalidCommandError,
  TransientFailureError,
  UniqueViolationError,
  WalletNotFoundError,
} from "../errors/application.error";
import type { WageringRepositories, WageringUnitOfWork } from "../ports/wagering-unit-of-work.port";
import type { ApplicationLogger, Clock, IdGenerator } from "../ports/runtime.port";
import { type CorrelationContext, settlementEvents } from "../services/wagering-events";

export interface ProcessWagerTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionOutcome {
  transaction: WagerTransaction;
  idempotentReplay: boolean;
}

export interface MessageDelivery {
  consumerName: string;
  messageId: string;
  receivedAt: Date;
}

export type MessageOutcome =
  | { kind: "settled"; outcome: WagerTransactionOutcome }
  | { kind: "duplicate-message"; samePayload: boolean }
  | { kind: "idempotency-conflict"; reason: string };

const MAX_ATTEMPTS = 3;

export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly unitOfWork: WageringUnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly logger: ApplicationLogger,
  ) {}

  async execute(
    command: ProcessWagerTransactionCommand,
    correlation: CorrelationContext,
  ): Promise<WagerTransactionOutcome> {
    const { money, payloadHash } = this.prepare(command);

    return this.withRetries(command, async () => {
      const replay = await this.unitOfWork.read((repositories) =>
        this.findExisting(repositories, command, payloadHash),
      );
      if (replay) return replay;

      return this.unitOfWork.transaction((repositories) =>
        this.settle(repositories, command, money, payloadHash, correlation),
      );
    });
  }

  async executeFromMessage(
    command: ProcessWagerTransactionCommand,
    correlation: CorrelationContext,
    delivery: MessageDelivery,
  ): Promise<MessageOutcome> {
    const { money, payloadHash } = this.prepare(command);

    return this.withRetries(command, () =>
      this.unitOfWork.transaction(async (repositories): Promise<MessageOutcome> => {
        const processed = InboxMessage.rehydrate({ ...delivery, payloadHash, processedAt: this.clock.now() });
        const claim = await repositories.inbox.claim(processed);
        if (!claim.claimed) return { kind: "duplicate-message", samePayload: claim.payloadHash === payloadHash };

        try {
          const outcome =
            (await this.findExisting(repositories, command, payloadHash)) ??
            (await this.settle(repositories, command, money, payloadHash, correlation));
          return { kind: "settled", outcome };
        } catch (error) {
          if (error instanceof IdempotencyConflictError) return { kind: "idempotency-conflict", reason: error.message };
          throw error;
        }
      }),
    );
  }

  private prepare(command: ProcessWagerTransactionCommand): { money: Money; payloadHash: string } {
    this.assertSubmittable(command);
    const money = Money.from(command.money);
    return { money, payloadHash: computePayloadHash({ ...command, money: money.toJSON() }) };
  }

  private async withRetries<T>(command: ProcessWagerTransactionCommand, attempt: () => Promise<T>): Promise<T> {
    for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber += 1) {
      try {
        return await attempt();
      } catch (error) {
        if (!(error instanceof UniqueViolationError)) throw error;
        this.logger.info(
          { providerId: command.providerId, walletId: command.walletId, context: error.constraint },
          "concurrent duplicate detected, retrying as replay",
        );
      }
    }

    throw new TransientFailureError("Could not settle the transaction after concurrent retries");
  }

  private assertSubmittable(command: ProcessWagerTransactionCommand): void {
    if (command.kind === WagerTransactionKind.Opening) {
      throw new InvalidCommandError("OPENING is internal and cannot be submitted");
    }
    if (command.providerId === INTERNAL_PROVIDER_ID) {
      throw new InvalidCommandError(`providerId "${INTERNAL_PROVIDER_ID}" is reserved`);
    }
  }

  private async findExisting(
    repositories: WageringRepositories,
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
  ): Promise<WagerTransactionOutcome | undefined> {
    const existing =
      (await repositories.transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey)) ??
      (await repositories.transactions.findByExternalId(command.providerId, command.externalTransactionId));

    if (!existing) return undefined;

    if (existing.idempotencyKey !== command.idempotencyKey) {
      throw new IdempotencyConflictError("External transaction id already used with a different idempotency key");
    }
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError("Idempotency key already used with a different payload");
    }

    return { transaction: existing, idempotentReplay: true };
  }

  private async settle(
    repositories: WageringRepositories,
    command: ProcessWagerTransactionCommand,
    money: Money,
    payloadHash: string,
    correlation: CorrelationContext,
  ): Promise<WagerTransactionOutcome> {
    const wallet = await repositories.wallets.findForUpdate(command.walletId);
    if (!wallet) throw new WalletNotFoundError(`Wallet ${command.walletId} not found`);

    const existing = await this.findExisting(repositories, command, payloadHash);
    if (existing) return existing;

    const now = this.clock.now();
    const transaction = WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      ...(command.referenceExternalTransactionId !== undefined && {
        referenceExternalTransactionId: command.referenceExternalTransactionId,
      }),
      createdAt: now,
    });

    const reference = command.referenceExternalTransactionId
      ? await repositories.transactions.findByExternalId(command.providerId, command.referenceExternalTransactionId)
      : undefined;
    const referenceAlreadyReversed =
      reference !== undefined && transaction.requiresReference()
        ? await repositories.transactions.hasProcessedReversal(reference.id)
        : false;

    const { entry } = settleTransaction({
      transaction,
      wallet,
      ...(reference && { reference }),
      referenceAlreadyReversed,
      ledgerEntryId: this.ids.next(),
      at: now,
    });

    repositories.transactions.add(transaction);
    if (entry) {
      repositories.ledger.append(entry);
      repositories.wallets.save(wallet);
    }
    for (const message of settlementEvents({ transaction, wallet, entry, correlation, ids: this.ids, at: now })) {
      repositories.outbox.enqueue(message);
    }

    this.logger.info(
      {
        transactionId: transaction.id,
        walletId: wallet.id,
        providerId: transaction.providerId,
        context: transaction.status,
      },
      "wager transaction settled",
    );

    return { transaction, idempotentReplay: false };
  }
}
