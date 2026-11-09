import type { WagerTransactionStatus } from "../../domain/entities/wager-transaction.entity";

export const WAGERING_METRICS = Symbol("WAGERING_METRICS");

export type SettlementSource = "http" | "queue" | "worker";

export type DuplicateKind = "idempotent-replay" | "duplicate-message" | "idempotency-conflict" | "message-id-reused";

export type RetryOperation = "unique-violation" | "message" | "publication" | "pending-reference";

export interface WageringMetrics {
  transactionSettled(status: WagerTransactionStatus, source: SettlementSource): void;
  duplicateDetected(kind: DuplicateKind): void;
  retried(operation: RetryOperation, times?: number): void;
  deadLettered(reason: string): void;
  lockConflict(): void;
  processingObserved(source: SettlementSource, seconds: number): void;
  outboxBacklog(pending: number, oldestAgeSeconds: number): void;
}

export const NO_METRICS: WageringMetrics = {
  transactionSettled: () => undefined,
  duplicateDetected: () => undefined,
  retried: () => undefined,
  deadLettered: () => undefined,
  lockConflict: () => undefined,
  processingObserved: () => undefined,
  outboxBacklog: () => undefined,
};
