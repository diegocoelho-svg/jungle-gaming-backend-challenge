import { Money } from "../../domain/value-objects/money.vo";
import { WalletNotFoundError } from "../errors/application.error";
import type { ApplicationLogger } from "../ports/runtime.port";
import type { WageringUnitOfWork } from "../ports/wagering-unit-of-work.port";

export interface ReconciliationReport {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

export interface ReconciliationMonitor {
  divergenceDetected(walletId: string): void;
}

export class ReconcileWalletUseCase {
  constructor(
    private readonly unitOfWork: WageringUnitOfWork,
    private readonly logger: ApplicationLogger,
    private readonly monitor: ReconciliationMonitor,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const report = await this.unitOfWork.transaction(
      async ({ wallets, ledger }) => {
        const wallet = await wallets.findById(walletId);
        if (!wallet) throw new WalletNotFoundError(`Wallet ${walletId} not found`);

        const summary = await ledger.summarize(walletId);
        const calculatedBalance = Money.rehydrate({ amount: summary.netAmount, currency: wallet.currency });
        const difference = wallet.balance.subtract(calculatedBalance);

        return {
          walletId,
          storedBalance: wallet.balance,
          calculatedBalance,
          difference,
          consistent: difference.isZero(),
          checkedEntries: summary.entries,
        };
      },
      { consistentSnapshot: true },
    );

    if (!report.consistent) {
      this.monitor.divergenceDetected(walletId);
      this.logger.warn({ walletId }, "wallet balance diverges from its ledger");
    }

    return report;
  }
}
