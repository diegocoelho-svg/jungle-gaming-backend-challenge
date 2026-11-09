import { describe, expect, test } from "bun:test";
import { LedgerDirection } from "../../../src/wagering/domain/entities/wallet-ledger-entry.entity";
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../../src/wagering/domain/entities/wager-transaction.entity";
import {
  InvalidTransactionError,
  InvalidTransactionStateError,
} from "../../../src/wagering/domain/errors/domain.error";
import { FailureCode } from "../../../src/wagering/domain/errors/failure-code";
import { Money } from "../../../src/wagering/domain/value-objects/money.vo";
import { aTransaction, brl, NOW } from "./fixtures";

const REF = { referenceExternalTransactionId: "tx-ref" };
const seconds = (date: Date | undefined) => ((date?.getTime() ?? 0) - NOW.getTime()) / 1_000;

const terminalTransactions: [string, () => WagerTransaction][] = [
  [
    "PROCESSED",
    () => {
      const transaction = aTransaction(Kind.Bet, "1.00");
      transaction.markProcessed(undefined, NOW, brl("1.00"));
      return transaction;
    },
  ],
  [
    "REJECTED",
    () => {
      const transaction = aTransaction(Kind.Bet, "1.00");
      transaction.reject(FailureCode.InsufficientFunds, brl("0.00"));
      return transaction;
    },
  ],
  [
    "FAILED",
    () => {
      const transaction = aTransaction(Kind.Bet, "1.00");
      transaction.markPendingReference(NOW);
      transaction.fail(FailureCode.InfrastructureFailure);
      return transaction;
    },
  ],
];

describe("WagerTransaction.create", () => {
  test("starts PENDING", () => {
    const transaction = aTransaction(Kind.Bet, "1.00");

    expect(transaction.status).toBe(Status.Pending);
    expect(transaction.isTerminal()).toBe(false);
  });

  test("OPENING cannot be submitted", () => {
    expect(() => aTransaction(Kind.Opening, "1.00")).toThrow(InvalidTransactionError);
  });

  test("an unknown kind is rejected", () => {
    expect(() => aTransaction("JACKPOT" as Kind, "5.00")).toThrow(InvalidTransactionError);
  });

  test.each([Kind.Win, Kind.Loss])("%s rejects an empty reference", (kind) => {
    expect(() => aTransaction(kind, "1.00", { referenceExternalTransactionId: "" })).toThrow(InvalidTransactionError);
  });

  test.each(["0.00", "-1.00"])("internal OPENING rejects balance %s", (amount) => {
    const money = Money.rehydrate({ amount, currency: "BRL" });

    expect(() => WagerTransaction.opening({ id: "t", walletId: "w", playerId: "p", money, at: NOW })).toThrow(
      InvalidTransactionError,
    );
  });

  test.each([Kind.Refund, Kind.Rollback])("%s requires a reference", (kind) => {
    expect(() => aTransaction(kind, "1.00")).toThrow(InvalidTransactionError);
    expect(aTransaction(kind, "1.00", REF).requiresReference()).toBe(true);
  });

  test("BET cannot reference another transaction", () => {
    expect(() => aTransaction(Kind.Bet, "1.00", REF)).toThrow(InvalidTransactionError);
  });

  test.each([Kind.Win, Kind.Loss])("%s may reference the bet it settles", (kind) => {
    expect(aTransaction(kind, "1.00", REF).referenceExternalTransactionId).toBe(REF.referenceExternalTransactionId);
  });

  test.each([Kind.Bet, Kind.Win, Kind.Loss])("%s does not require a reference", (kind) => {
    expect(aTransaction(kind, "1.00").requiresReference()).toBe(false);
  });

  test.each([Kind.Bet, Kind.Win])("%s rejects a zero amount", (kind) => {
    expect(() => aTransaction(kind, "0.00")).toThrow(InvalidTransactionError);
  });

  test.each([Kind.Refund, Kind.Rollback])("%s rejects a zero amount", (kind) => {
    expect(() => aTransaction(kind, "0.00", REF)).toThrow(InvalidTransactionError);
  });

  test("LOSS accepts a zero amount", () => {
    expect(aTransaction(Kind.Loss, "0.00").status).toBe(Status.Pending);
  });
});

describe("queries", () => {
  test("only LOSS leaves the balance untouched", () => {
    expect(aTransaction(Kind.Loss, "1.00").affectsBalance()).toBe(false);
    expect(aTransaction(Kind.Bet, "1.00").affectsBalance()).toBe(true);
  });

  test("idempotency key with a divergent payload does not match", () => {
    const transaction = aTransaction(Kind.Bet, "1.00", { payloadHash: "original" });

    expect(transaction.matchesPayload("original")).toBe(true);
    expect(transaction.matchesPayload("divergent")).toBe(false);
  });
});

describe("ledgerDirectionFor", () => {
  test("BET debits", () => {
    expect(aTransaction(Kind.Bet, "1.00").ledgerDirectionFor()).toBe(LedgerDirection.Debit);
  });

  test.each([Kind.Win])("%s credits", (kind) => {
    expect(aTransaction(kind, "1.00").ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test("REFUND credits", () => {
    expect(aTransaction(Kind.Refund, "1.00", REF).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test("ROLLBACK inverts the reference", () => {
    const rollback = aTransaction(Kind.Rollback, "1.00", REF);

    expect(rollback.ledgerDirectionFor(aTransaction(Kind.Bet, "1.00"))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(aTransaction(Kind.Win, "1.00"))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(aTransaction(Kind.Refund, "1.00", REF))).toBe(LedgerDirection.Debit);
  });

  test("ROLLBACK without a reference is a programming error", () => {
    expect(() => aTransaction(Kind.Rollback, "1.00", REF).ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });

  test("an unknown kind from the database does not become a credit", () => {
    const transaction = WagerTransaction.rehydrate({
      id: "t",
      providerId: "p",
      externalTransactionId: "e",
      idempotencyKey: "k",
      payloadHash: "h",
      walletId: "w",
      playerId: "pl",
      roundId: "r",
      gameId: "g",
      kind: "JACKPOT" as Kind,
      money: brl("1.00"),
      createdAt: NOW,
      status: Status.Pending,
      referenceAttempts: 0,
    });

    expect(() => transaction.ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });

  test("LOSS has no direction", () => {
    expect(() => aTransaction(Kind.Loss, "1.00").ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });
});

describe("valid transitions", () => {
  test("PENDING to PROCESSED stores reference, date and balance", () => {
    const transaction = aTransaction(Kind.Bet, "1.00");

    transaction.markProcessed("ref-id", NOW, brl("9.00"));

    expect(transaction.status).toBe(Status.Processed);
    expect(transaction.referenceTransactionId).toBe("ref-id");
    expect(transaction.processedAt).toEqual(NOW);
    expect(transaction.resultBalance?.equals(brl("9.00"))).toBe(true);
    expect(transaction.isTerminal()).toBe(true);
  });

  test("PENDING to REJECTED stores code and balance", () => {
    const transaction = aTransaction(Kind.Bet, "1.00");

    transaction.reject(FailureCode.InsufficientFunds, brl("0.50"));

    expect(transaction.status).toBe(Status.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(transaction.resultBalance?.equals(brl("0.50"))).toBe(true);
  });

  test("PENDING_REFERENCE can end as PROCESSED, REJECTED or FAILED", () => {
    const pending = () => {
      const transaction = aTransaction(Kind.Bet, "1.00");
      transaction.markPendingReference(NOW);
      return transaction;
    };

    const processed = pending();
    processed.markProcessed(undefined, NOW, brl("1.00"));
    const rejected = pending();
    rejected.reject(FailureCode.ReferenceNotFound, brl("1.00"));
    const failed = pending();
    failed.fail(FailureCode.InfrastructureFailure);

    expect(processed.status).toBe(Status.Processed);
    expect(processed.nextReferenceAttemptAt).toBeUndefined();
    expect(rejected.status).toBe(Status.Rejected);
    expect(failed.status).toBe(Status.Failed);
    expect(failed.failureCode).toBe(FailureCode.InfrastructureFailure);
  });
});

describe("invalid transitions", () => {
  test.each(terminalTransactions)("%s is terminal", (_, build) => {
    const transaction = build();

    expect(transaction.isTerminal()).toBe(true);
    expect(() => transaction.markProcessed(undefined, NOW, brl("1.00"))).toThrow(InvalidTransactionStateError);
    expect(() => transaction.markPendingReference(NOW)).toThrow(InvalidTransactionStateError);
    expect(() => transaction.scheduleReferenceRetry(NOW)).toThrow(InvalidTransactionStateError);
    expect(() => transaction.reject(FailureCode.ReferenceMismatch, brl("1.00"))).toThrow(InvalidTransactionStateError);
    expect(() => transaction.fail(FailureCode.InfrastructureFailure)).toThrow(InvalidTransactionStateError);
  });

  test("PENDING cannot go straight to FAILED", () => {
    expect(() => aTransaction(Kind.Bet, "1.00").fail(FailureCode.InfrastructureFailure)).toThrow(
      InvalidTransactionStateError,
    );
  });

  test("PENDING_REFERENCE cannot re-enter PENDING_REFERENCE", () => {
    const transaction = aTransaction(Kind.Bet, "1.00");
    transaction.markPendingReference(NOW);

    expect(() => transaction.markPendingReference(NOW)).toThrow(InvalidTransactionStateError);
  });
});

describe("reference backoff", () => {
  test("grows exponentially up to a 5 minute cap", () => {
    const transaction = aTransaction(Kind.Refund, "1.00", REF);
    const delays: number[] = [];

    transaction.markPendingReference(NOW);
    delays.push(seconds(transaction.nextReferenceAttemptAt));
    for (let attempt = 0; attempt < 7; attempt += 1) {
      transaction.scheduleReferenceRetry(NOW);
      delays.push(seconds(transaction.nextReferenceAttemptAt));
    }

    expect(delays).toEqual([5, 10, 20, 40, 80, 160, 300, 300]);
  });

  test("is exhausted on the 12th attempt", () => {
    const transaction = aTransaction(Kind.Refund, "1.00", REF);
    transaction.markPendingReference(NOW);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(transaction.hasExhaustedReferenceAttempts()).toBe(false);
      transaction.scheduleReferenceRetry(NOW);
    }

    expect(transaction.referenceAttempts).toBe(10);
    expect(transaction.hasExhaustedReferenceAttempts()).toBe(false);
    transaction.scheduleReferenceRetry(NOW);
    expect(transaction.hasExhaustedReferenceAttempts()).toBe(true);
  });
});

describe("WagerTransaction.rehydrate", () => {
  test("rebuilds a terminal state without revalidating", () => {
    const transaction = WagerTransaction.rehydrate({
      id: "t",
      providerId: "p",
      externalTransactionId: "e",
      idempotencyKey: "k",
      payloadHash: "h",
      walletId: "w",
      playerId: "pl",
      roundId: "r",
      gameId: "g",
      kind: Kind.Opening,
      money: brl("0.00"),
      createdAt: NOW,
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      referenceAttempts: 3,
    });

    expect(transaction.status).toBe(Status.Rejected);
    expect(transaction.referenceAttempts).toBe(3);
  });
});
