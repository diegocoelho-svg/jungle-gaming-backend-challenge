import type { InboxMessage } from "../../domain/entities/inbox-message.entity";
import type { OutboxMessage } from "../../domain/entities/outbox-message.entity";
import type { WagerTransaction } from "../../domain/entities/wager-transaction.entity";
import type { WalletLedgerEntry } from "../../domain/entities/wallet-ledger-entry.entity";
import type { Wallet } from "../../domain/entities/wallet.entity";

export const WAGERING_UNIT_OF_WORK = Symbol("WAGERING_UNIT_OF_WORK");

export interface WalletRepository {
  findById(walletId: string): Promise<Wallet | undefined>;
  findForUpdate(walletId: string): Promise<Wallet | undefined>;
  add(wallet: Wallet): void;
  save(wallet: Wallet): void;
}

export interface WagerTransactionRepository {
  findById(transactionId: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  add(transaction: WagerTransaction): void;
  save(transaction: WagerTransaction): void;
}

export interface LedgerSummary {
  netAmount: string;
  entries: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): void;
  listAfterVersion(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]>;
  summarize(walletId: string): Promise<LedgerSummary>;
}

export interface OutboxRepository {
  enqueue(message: OutboxMessage): void;
}

export type InboxClaim = { claimed: true } | { claimed: false; payloadHash: string };

export interface InboxRepository {
  claim(message: InboxMessage): Promise<InboxClaim>;
}

export interface WageringRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}

export interface TransactionOptions {
  consistentSnapshot?: boolean;
}

export interface WageringUnitOfWork {
  transaction<T>(work: (repositories: WageringRepositories) => Promise<T>, options?: TransactionOptions): Promise<T>;
  read<T>(work: (repositories: WageringRepositories) => Promise<T>): Promise<T>;
}
