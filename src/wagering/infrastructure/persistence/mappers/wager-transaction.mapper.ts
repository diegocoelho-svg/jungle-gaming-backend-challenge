import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../../../domain/entities/wager-transaction.entity";
import type { FailureCode } from "../../../domain/errors/failure-code";
import { Money } from "../../../domain/value-objects/money.vo";
import { WagerTransactionSchema } from "../schemas/wager-transaction.schema";

export function wagerTransactionToDomain(row: WagerTransactionSchema): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind as WagerTransactionKind,
    money: Money.rehydrate({ amount: row.amount, currency: row.currency }),
    referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
    createdAt: row.createdAt,
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    failureCode: (row.failureCode as FailureCode | null) ?? undefined,
    processedAt: row.processedAt ?? undefined,
    resultBalance:
      row.resultBalance !== null && row.resultBalanceCurrency !== null
        ? Money.rehydrate({ amount: row.resultBalance, currency: row.resultBalanceCurrency })
        : undefined,
    referenceAttempts: row.referenceAttempts,
    nextReferenceAttemptAt: row.nextReferenceAttemptAt ?? undefined,
  });
}

export function wagerTransactionToSchema(
  transaction: WagerTransaction,
  row: WagerTransactionSchema = new WagerTransactionSchema(),
): WagerTransactionSchema {
  const money = transaction.money.toJSON();
  const resultBalance = transaction.resultBalance?.toJSON();

  row.id = transaction.id;
  row.providerId = transaction.providerId;
  row.externalTransactionId = transaction.externalTransactionId;
  row.idempotencyKey = transaction.idempotencyKey;
  row.payloadHash = transaction.payloadHash;
  row.walletId = transaction.walletId;
  row.playerId = transaction.playerId;
  row.roundId = transaction.roundId;
  row.gameId = transaction.gameId;
  row.kind = transaction.kind;
  row.amount = money.amount;
  row.currency = money.currency;
  row.referenceExternalTransactionId = transaction.referenceExternalTransactionId ?? null;
  row.referenceTransactionId = transaction.referenceTransactionId ?? null;
  row.status = transaction.status;
  row.failureCode = transaction.failureCode ?? null;
  row.resultBalance = resultBalance?.amount ?? null;
  row.resultBalanceCurrency = resultBalance?.currency ?? null;
  row.referenceAttempts = transaction.referenceAttempts;
  row.nextReferenceAttemptAt = transaction.nextReferenceAttemptAt ?? null;
  row.createdAt = transaction.createdAt;
  row.processedAt = transaction.processedAt ?? null;
  return row;
}
