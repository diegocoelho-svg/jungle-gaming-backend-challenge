import { Counter, Gauge, Histogram, type Registry } from "prom-client";
import type { Clock, IdGenerator } from "../application/ports/runtime.port";
import type {
  DuplicateKind,
  RetryOperation,
  SettlementSource,
  WageringMetrics,
} from "../application/ports/wagering-metrics.port";
import type { WagerTransactionStatus } from "../domain/entities/wager-transaction.entity";
import type { ReconciliationMonitor } from "../application/use-cases/reconcile-wallet.use-case";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}

export class PrometheusReconciliationMonitor implements ReconciliationMonitor {
  private readonly divergences: Counter;

  constructor(registry: Registry) {
    this.divergences = new Counter({
      name: "wagering_reconciliation_divergences_total",
      help: "Reconciliations whose stored balance differs from the ledger",
      registers: [registry],
    });
  }

  divergenceDetected(): void {
    this.divergences.inc();
  }
}

export class PrometheusWageringMetrics implements WageringMetrics {
  private readonly transactions: Counter<"status" | "source">;
  private readonly duplicates: Counter<"kind">;
  private readonly retries: Counter<"operation">;
  private readonly deadLetters: Counter<"reason">;
  private readonly lockConflicts: Counter;
  private readonly processing: Histogram<"source">;
  private outbox?: { pending: Gauge; lag: Gauge };

  constructor(private readonly registry: Registry) {
    const registers = [registry];
    this.transactions = new Counter({
      name: "wagering_transactions_total",
      help: "Settlement outcomes by status and entry point; a pending reference is counted again when the worker resolves it",
      labelNames: ["status", "source"],
      registers,
    });
    this.duplicates = new Counter({
      name: "wagering_duplicates_total",
      help: "Duplicate submissions and messages detected",
      labelNames: ["kind"],
      registers,
    });
    this.retries = new Counter({
      name: "wagering_retries_total",
      help: "Retries by operation",
      labelNames: ["operation"],
      registers,
    });
    this.deadLetters = new Counter({
      name: "wagering_dead_letters_total",
      help: "Messages the consumer sent straight to the dead-letter queue, by reason",
      labelNames: ["reason"],
      registers,
    });
    this.lockConflicts = new Counter({
      name: "wagering_lock_conflicts_total",
      help: "Lock timeouts and deadlocks reported by PostgreSQL",
      registers,
    });
    this.processing = new Histogram({
      name: "wagering_processing_duration_seconds",
      help: "Time to process a wager transaction, including replays and failures",
      labelNames: ["source"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers,
    });
  }

  transactionSettled(status: WagerTransactionStatus, source: SettlementSource): void {
    this.transactions.inc({ status, source });
  }

  duplicateDetected(kind: DuplicateKind): void {
    this.duplicates.inc({ kind });
  }

  retried(operation: RetryOperation, times = 1): void {
    this.retries.inc({ operation }, times);
  }

  deadLettered(reason: string): void {
    this.deadLetters.inc({ reason });
  }

  lockConflict(): void {
    this.lockConflicts.inc();
  }

  processingObserved(source: SettlementSource, seconds: number): void {
    this.processing.observe({ source }, seconds);
  }

  outboxBacklog(pending: number, oldestAgeSeconds: number): void {
    this.outbox ??= {
      pending: new Gauge({
        name: "wagering_outbox_pending",
        help: "Outbox events not yet published",
        registers: [this.registry],
      }),
      lag: new Gauge({
        name: "wagering_outbox_lag_seconds",
        help: "Age of the oldest unpublished outbox event",
        registers: [this.registry],
      }),
    };
    this.outbox.pending.set(pending);
    this.outbox.lag.set(oldestAgeSeconds);
  }
}
