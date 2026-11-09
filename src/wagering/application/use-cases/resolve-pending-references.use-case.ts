import { WagerTransactionStatus } from "../../domain/entities/wager-transaction.entity";
import { settleTransaction } from "../../domain/services/settle-transaction.service";
import { TransientFailureError } from "../errors/application.error";
import type { ApplicationLogger, Clock, IdGenerator } from "../ports/runtime.port";
import { NO_METRICS, type WageringMetrics } from "../ports/wagering-metrics.port";
import type { WageringRepositories, WageringUnitOfWork } from "../ports/wagering-unit-of-work.port";
import { settlementEvents } from "../services/wagering-events";

export interface ResolutionReport {
  claimed: number;
  resolved: number;
  rescheduled: number;
}

type Resolution =
  | { kind: "resolved"; status: WagerTransactionStatus }
  | { kind: "rescheduled" }
  | { kind: "skipped" }
  | { kind: "none" };

export class ResolvePendingReferencesUseCase {
  constructor(
    private readonly unitOfWork: WageringUnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly logger: ApplicationLogger,
    private readonly metrics: WageringMetrics = NO_METRICS,
  ) {}

  async resolveDue(limit: number): Promise<ResolutionReport> {
    const report: ResolutionReport = { claimed: 0, resolved: 0, rescheduled: 0 };
    while (report.claimed < limit) {
      const resolution = await this.resolveNext();
      if (resolution.kind === "none") break;
      report.claimed += 1;
      if (resolution.kind === "resolved") {
        report.resolved += 1;
        this.metrics.transactionSettled(resolution.status, "worker");
      }
      if (resolution.kind === "rescheduled") {
        report.rescheduled += 1;
        this.metrics.retried("pending-reference");
      }
    }
    return report;
  }

  private async resolveNext(): Promise<Resolution> {
    try {
      return await this.unitOfWork.transaction((repositories) => this.resolve(repositories));
    } catch (error) {
      if (!(error instanceof TransientFailureError)) throw error;
      this.logger.warn({ err: error, context: "pending-reference" }, "pending reference left for the next attempt");
      return { kind: "none" };
    }
  }

  private async resolve(repositories: WageringRepositories): Promise<Resolution> {
    const claim = await repositories.transactions.claimNextDuePendingReference(this.clock.now());
    if (!claim) return { kind: "none" };
    const { transactionId, walletId } = claim;

    const wallet = await repositories.wallets.findForUpdate(walletId);
    const transaction = await repositories.transactions.findById(transactionId);
    if (!wallet || transaction?.status !== WagerTransactionStatus.PendingReference) return { kind: "skipped" };

    const reference = await repositories.transactions.findByExternalId(
      transaction.providerId,
      transaction.referenceExternalTransactionId ?? "",
    );
    const referenceAlreadyReversed =
      reference !== undefined && transaction.requiresReference()
        ? await repositories.transactions.hasProcessedReversal(reference.id)
        : false;

    const now = this.clock.now();
    const { entry } = settleTransaction({
      transaction,
      wallet,
      ...(reference && { reference }),
      referenceAlreadyReversed,
      ledgerEntryId: this.ids.next(),
      at: now,
    });

    repositories.transactions.save(transaction);
    if (transaction.status === WagerTransactionStatus.PendingReference) return { kind: "rescheduled" };

    if (entry) {
      repositories.ledger.append(entry);
      repositories.wallets.save(wallet);
    }
    const correlation = { correlationId: transaction.id, causationId: transaction.id };
    for (const message of settlementEvents({ transaction, wallet, entry, correlation, ids: this.ids, at: now })) {
      repositories.outbox.enqueue(message);
    }

    this.logger.info(
      { transactionId, walletId, providerId: transaction.providerId, context: transaction.status },
      "pending reference resolved",
    );
    return { kind: "resolved", status: transaction.status };
  }
}
