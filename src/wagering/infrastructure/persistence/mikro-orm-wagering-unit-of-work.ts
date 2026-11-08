import { type EntityManager, IsolationLevel, LockMode } from "@mikro-orm/postgresql";
import { TransientFailureError, UniqueViolationError } from "../../application/errors/application.error";
import type {
  InboxClaim,
  InboxRepository,
  LedgerRepository,
  LedgerSummary,
  OutboxRepository,
  TransactionOptions,
  WageringRepositories,
  WageringUnitOfWork,
  WagerTransactionRepository,
  WalletRepository,
} from "../../application/ports/wagering-unit-of-work.port";
import type { InboxMessage } from "../../domain/entities/inbox-message.entity";
import type { OutboxMessage } from "../../domain/entities/outbox-message.entity";
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/entities/wager-transaction.entity";
import type { WalletLedgerEntry } from "../../domain/entities/wallet-ledger-entry.entity";
import type { Wallet } from "../../domain/entities/wallet.entity";
import { constraintOf, isTransientDatabaseFailure, isUniqueViolation } from "./database-errors";
import { outboxMessageToSchema } from "./mappers/message.mapper";
import { ledgerEntryToDomain, ledgerEntryToSchema } from "./mappers/wallet-ledger-entry.mapper";
import { walletToDomain, walletToSchema } from "./mappers/wallet.mapper";
import { wagerTransactionToDomain, wagerTransactionToSchema } from "./mappers/wager-transaction.mapper";
import { WagerTransactionSchema } from "./schemas/wager-transaction.schema";
import { WalletLedgerEntrySchema } from "./schemas/wallet-ledger-entry.schema";
import { WalletSchema } from "./schemas/wallet.schema";

const LOCK_TIMEOUT = "2s";

class MikroOrmWalletRepository implements WalletRepository {
  private readonly rows = new Map<string, WalletSchema>();

  constructor(private readonly em: EntityManager) {}

  async findById(walletId: string): Promise<Wallet | undefined> {
    return this.track(await this.em.findOne(WalletSchema, walletId));
  }

  async findForUpdate(walletId: string): Promise<Wallet | undefined> {
    return this.track(await this.em.findOne(WalletSchema, walletId, { lockMode: LockMode.PESSIMISTIC_WRITE }));
  }

  add(wallet: Wallet): void {
    this.em.persist(walletToSchema(wallet));
  }

  save(wallet: Wallet): void {
    const row = this.rows.get(wallet.id);
    if (!row) throw new Error(`Wallet ${wallet.id} was not loaded in this unit of work`);
    walletToSchema(wallet, row);
  }

  private track(row: WalletSchema | null): Wallet | undefined {
    if (!row) return undefined;
    this.rows.set(row.id, row);
    return walletToDomain(row);
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  private readonly rows = new Map<string, WagerTransactionSchema>();

  constructor(private readonly em: EntityManager) {}

  async findById(transactionId: string): Promise<WagerTransaction | undefined> {
    return this.track(await this.em.findOne(WagerTransactionSchema, transactionId));
  }

  async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.track(await this.em.findOne(WagerTransactionSchema, { providerId, idempotencyKey }));
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.track(await this.em.findOne(WagerTransactionSchema, { providerId, externalTransactionId }));
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  add(transaction: WagerTransaction): void {
    this.em.persist(wagerTransactionToSchema(transaction));
  }

  save(transaction: WagerTransaction): void {
    const row = this.rows.get(transaction.id);
    if (!row) throw new Error(`Transaction ${transaction.id} was not loaded in this unit of work`);
    wagerTransactionToSchema(transaction, row);
  }

  private track(row: WagerTransactionSchema | null): WagerTransaction | undefined {
    if (!row) return undefined;
    this.rows.set(row.id, row);
    return wagerTransactionToDomain(row);
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  append(entry: WalletLedgerEntry): void {
    this.em.persist(ledgerEntryToSchema(entry));
  }

  async listAfterVersion(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]> {
    const rows = await this.em.find(
      WalletLedgerEntrySchema,
      { walletId, walletVersion: { $gt: afterVersion } },
      { orderBy: { walletVersion: "asc" }, limit },
    );
    return rows.map(ledgerEntryToDomain);
  }

  async summarize(walletId: string): Promise<LedgerSummary> {
    const [row] = await this.em.getConnection().execute<{ net_amount: string; entries: number }[]>(
      `select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(20, 2) as net_amount,
              count(*)::int as entries
         from wallet_ledger_entries
        where wallet_id = ?`,
      [walletId],
      "all",
      this.em.getTransactionContext(),
    );
    return { netAmount: row?.net_amount ?? "0.00", entries: row?.entries ?? 0 };
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  enqueue(message: OutboxMessage): void {
    this.em.persist(outboxMessageToSchema(message));
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async claim(message: InboxMessage): Promise<InboxClaim> {
    const context = this.em.getTransactionContext();
    const connection = this.em.getConnection();
    const inserted = await connection.execute<{ message_id: string }[]>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt, message.processedAt ?? null],
      "all",
      context,
    );
    if (inserted.length > 0) return { claimed: true };

    const [existing] = await connection.execute<{ payload_hash: string }[]>(
      "select payload_hash from inbox_messages where consumer_name = ? and message_id = ?",
      [message.consumerName, message.messageId],
      "all",
      context,
    );
    return { claimed: false, payloadHash: existing?.payload_hash ?? "" };
  }
}

const repositoriesFor = (em: EntityManager): WageringRepositories => ({
  wallets: new MikroOrmWalletRepository(em),
  transactions: new MikroOrmWagerTransactionRepository(em),
  ledger: new MikroOrmLedgerRepository(em),
  outbox: new MikroOrmOutboxRepository(em),
  inbox: new MikroOrmInboxRepository(em),
});

function translate(error: unknown): unknown {
  if (isUniqueViolation(error)) return new UniqueViolationError(constraintOf(error));
  if (isTransientDatabaseFailure(error)) return new TransientFailureError("Database temporarily unavailable");
  return error;
}

export class MikroOrmWageringUnitOfWork implements WageringUnitOfWork {
  constructor(private readonly em: EntityManager) {}

  async transaction<T>(
    work: (repositories: WageringRepositories) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    try {
      return await this.em.fork().transactional(
        async (em) => {
          await em
            .getConnection()
            .execute(`set local lock_timeout = '${LOCK_TIMEOUT}'`, [], "run", em.getTransactionContext());
          return work(repositoriesFor(em));
        },
        options.consistentSnapshot ? { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true } : {},
      );
    } catch (error) {
      throw translate(error);
    }
  }

  async read<T>(work: (repositories: WageringRepositories) => Promise<T>): Promise<T> {
    try {
      return await work(repositoriesFor(this.em.fork()));
    } catch (error) {
      throw translate(error);
    }
  }
}
