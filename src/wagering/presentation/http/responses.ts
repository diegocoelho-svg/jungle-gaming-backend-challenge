import { HttpStatus } from "@nestjs/common";
import type { WagerTransactionOutcome } from "../../application/use-cases/process-wager-transaction.use-case";
import type { ReconciliationReport } from "../../application/use-cases/reconcile-wallet.use-case";
import { type WagerTransaction, WagerTransactionStatus } from "../../domain/entities/wager-transaction.entity";
import type { WalletLedgerEntry } from "../../domain/entities/wallet-ledger-entry.entity";
import type { Wallet } from "../../domain/entities/wallet.entity";

export const walletResponse = (wallet: Wallet) => ({
  id: wallet.id,
  playerId: wallet.playerId,
  balance: wallet.balance.toJSON(),
  version: wallet.version,
});

export const transactionResponse = (transaction: WagerTransaction) => ({
  id: transaction.id,
  providerId: transaction.providerId,
  externalTransactionId: transaction.externalTransactionId,
  idempotencyKey: transaction.idempotencyKey,
  walletId: transaction.walletId,
  playerId: transaction.playerId,
  roundId: transaction.roundId,
  gameId: transaction.gameId,
  kind: transaction.kind,
  money: transaction.money.toJSON(),
  status: transaction.status,
  referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
  referenceTransactionId: transaction.referenceTransactionId ?? null,
  failureCode: transaction.failureCode ?? null,
  balance: transaction.resultBalance?.toJSON() ?? null,
  createdAt: transaction.createdAt.toISOString(),
  processedAt: transaction.processedAt?.toISOString() ?? null,
});

export const ledgerEntryResponse = (entry: WalletLedgerEntry) => ({
  id: entry.id,
  transactionId: entry.transactionId,
  direction: entry.direction,
  money: entry.money.toJSON(),
  balanceBefore: entry.balanceBefore.toJSON(),
  balanceAfter: entry.balanceAfter.toJSON(),
  walletVersion: entry.walletVersion,
  createdAt: entry.createdAt.toISOString(),
});

export const reconciliationResponse = (report: ReconciliationReport) => ({
  walletId: report.walletId,
  storedBalance: report.storedBalance.toJSON(),
  calculatedBalance: report.calculatedBalance.toJSON(),
  difference: report.difference.toJSON(),
  consistent: report.consistent,
  checkedEntries: report.checkedEntries,
});

const STATUS_CODES: Record<WagerTransactionStatus, HttpStatus> = {
  [WagerTransactionStatus.Processed]: HttpStatus.OK,
  [WagerTransactionStatus.PendingReference]: HttpStatus.ACCEPTED,
  [WagerTransactionStatus.Pending]: HttpStatus.ACCEPTED,
  [WagerTransactionStatus.Rejected]: HttpStatus.UNPROCESSABLE_ENTITY,
  [WagerTransactionStatus.Failed]: HttpStatus.INTERNAL_SERVER_ERROR,
};

export function submissionResponse({ transaction, idempotentReplay }: WagerTransactionOutcome) {
  return {
    statusCode: STATUS_CODES[transaction.status],
    body: {
      transactionId: transaction.id,
      status: transaction.status,
      balance: transaction.resultBalance?.toJSON() ?? null,
      ...(transaction.failureCode && { failureCode: transaction.failureCode }),
      idempotentReplay,
    },
  };
}
