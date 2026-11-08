import { OutboxMessage } from "../../domain/entities/outbox-message.entity";
import type { Wallet } from "../../domain/entities/wallet.entity";
import { WagerTransactionProcessed } from "../../domain/events/wager-transaction-processed.event";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed.event";
import { openWallet } from "../../domain/services/open-wallet.service";
import { Money, type MoneyProps } from "../../domain/value-objects/money.vo";
import { InvalidCommandError, UniqueViolationError, WalletAlreadyExistsError } from "../errors/application.error";
import type { ApplicationLogger, Clock, IdGenerator } from "../ports/runtime.port";
import type { WageringUnitOfWork } from "../ports/wagering-unit-of-work.port";
import type { CorrelationContext } from "../services/wagering-events";

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export class OpenWalletUseCase {
  constructor(
    private readonly unitOfWork: WageringUnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly logger: ApplicationLogger,
  ) {}

  async execute(command: OpenWalletCommand, correlation: CorrelationContext): Promise<Wallet> {
    if (!command.playerId) throw new InvalidCommandError("playerId is required");

    const at = this.clock.now();
    const { wallet, opening } = openWallet({
      walletId: this.ids.next(),
      playerId: command.playerId,
      initialBalance: Money.from(command.initialBalance),
      openingTransactionId: this.ids.next(),
      openingEntryId: this.ids.next(),
      at,
    });

    try {
      await this.unitOfWork.transaction(async (repositories) => {
        repositories.wallets.add(wallet);
        if (!opening) return;

        repositories.transactions.add(opening.transaction);
        repositories.ledger.append(opening.entry);
        const context = () => ({ ...correlation, eventId: this.ids.next(), occurredAt: at });
        repositories.outbox.enqueue(
          OutboxMessage.enqueue(WagerTransactionProcessed.from(opening.transaction, context())),
        );
        repositories.outbox.enqueue(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, opening.entry, context())));
      });
    } catch (error) {
      if (error instanceof UniqueViolationError) {
        throw new WalletAlreadyExistsError("A wallet already exists for this player and currency");
      }
      throw error;
    }

    this.logger.info({ walletId: wallet.id }, "wallet opened");
    return wallet;
  }
}
