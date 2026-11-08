import { Counter, type Registry } from "prom-client";
import type { Clock, IdGenerator } from "../application/ports/runtime.port";
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
