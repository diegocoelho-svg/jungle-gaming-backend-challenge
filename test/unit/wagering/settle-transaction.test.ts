import { describe, expect, test } from "bun:test";
import { LedgerDirection } from "../../../src/wagering/domain/entities/wallet-ledger-entry.entity";
import { Wallet } from "../../../src/wagering/domain/entities/wallet.entity";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../../src/wagering/domain/entities/wager-transaction.entity";
import {
  InvalidTransactionError,
  InvalidTransactionStateError,
} from "../../../src/wagering/domain/errors/domain.error";
import { FailureCode } from "../../../src/wagering/domain/errors/failure-code";
import { Money } from "../../../src/wagering/domain/value-objects/money.vo";
import { aProcessed, aTransaction, aWallet, brl, NOW, PLAYER_ID, settle } from "./fixtures";

const ref = (externalTransactionId: string) => ({ referenceExternalTransactionId: externalTransactionId });

describe("BET", () => {
  test("debits and creates a DEBIT entry", () => {
    const wallet = aWallet("100.00");
    const bet = aTransaction(Kind.Bet, "25.00");

    const { entry } = settle(bet, wallet);

    expect(bet.status).toBe(Status.Processed);
    expect(bet.resultBalance?.equals(brl("75.00"))).toBe(true);
    expect(wallet.balance.equals(brl("75.00"))).toBe(true);
    expect(entry?.direction).toBe(LedgerDirection.Debit);
    expect(entry?.transactionId).toBe(bet.id);
  });

  test("without funds becomes REJECTED, with no ledger entry, storing the observed balance", () => {
    const wallet = aWallet("10.00");
    const bet = aTransaction(Kind.Bet, "25.00");

    const { entry } = settle(bet, wallet);

    expect(bet.status).toBe(Status.Rejected);
    expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(bet.resultBalance?.equals(brl("10.00"))).toBe(true);
    expect(entry).toBeUndefined();
    expect(wallet.version).toBe(1);
  });

  test("required scenario: 100.00 with two 80.00 bets", () => {
    const wallet = aWallet("100.00");
    const first = aTransaction(Kind.Bet, "80.00");
    const second = aTransaction(Kind.Bet, "80.00");

    const results = [settle(first, wallet), settle(second, wallet)];

    expect(first.status).toBe(Status.Processed);
    expect(second.status).toBe(Status.Rejected);
    expect(second.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(wallet.balance.equals(brl("20.00"))).toBe(true);
    expect(results.filter(({ entry }) => entry)).toHaveLength(1);
  });
});

describe("WIN", () => {
  test("credits without a reference", () => {
    const wallet = aWallet("10.00");
    const win = aTransaction(Kind.Win, "5.00");

    const { entry } = settle(win, wallet);

    expect(win.status).toBe(Status.Processed);
    expect(wallet.balance.equals(brl("15.00"))).toBe(true);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
  });

  test("credits with a reference and stores the internal id", () => {
    const wallet = aWallet("10.00");
    const bet = aProcessed(Kind.Bet, "5.00", wallet);
    const win = aTransaction(Kind.Win, "50.00", ref(bet.externalTransactionId));

    settle(win, wallet, { reference: bet });

    expect(win.referenceTransactionId).toBe(bet.id);
  });

  test("with a missing reference becomes PENDING_REFERENCE", () => {
    const win = aTransaction(Kind.Win, "5.00", ref("tx-futura"));

    settle(win, aWallet());

    expect(win.status).toBe(Status.PendingReference);
  });

  test("above the column limit becomes REJECTED", () => {
    const wallet = aWallet("999999999999999999.99");
    const win = aTransaction(Kind.Win, "0.01");

    settle(win, wallet);

    expect(win.status).toBe(Status.Rejected);
    expect(win.failureCode).toBe(FailureCode.BalanceLimitExceeded);
  });

  test("a REJECTED BET cannot be referenced by WIN", () => {
    const wallet = aWallet("1.00");
    const bet = aProcessed(Kind.Bet, "50.00", wallet);
    const win = aTransaction(Kind.Win, "5.00", ref(bet.externalTransactionId));

    settle(win, wallet, { reference: bet });

    expect(win.failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });
});

describe("LOSS", () => {
  test("records the outcome without moving balance or creating ledger entries", () => {
    const wallet = aWallet("10.00");
    const loss = aTransaction(Kind.Loss, "5.00");

    const { entry } = settle(loss, wallet);

    expect(loss.status).toBe(Status.Processed);
    expect(loss.resultBalance?.equals(brl("10.00"))).toBe(true);
    expect(entry).toBeUndefined();
    expect(wallet.version).toBe(1);
  });

  test("with a reference stores the BET id", () => {
    const wallet = aWallet("10.00");
    const bet = aProcessed(Kind.Bet, "5.00", wallet);
    const loss = aTransaction(Kind.Loss, "0.00", ref(bet.externalTransactionId));

    settle(loss, wallet, { reference: bet });

    expect(loss.status).toBe(Status.Processed);
    expect(loss.referenceTransactionId).toBe(bet.id);
  });
});

describe("REFUND", () => {
  test("credits the amount of a processed BET", () => {
    const wallet = aWallet("100.00");
    const bet = aProcessed(Kind.Bet, "25.00", wallet);
    const refund = aTransaction(Kind.Refund, "25.00", ref(bet.externalTransactionId));

    const { entry } = settle(refund, wallet, { reference: bet });

    expect(refund.status).toBe(Status.Processed);
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.equals(brl("100.00"))).toBe(true);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
  });

  test.each([Kind.Win, Kind.Loss])("cannot reference %s", (kind) => {
    const wallet = aWallet("100.00");
    const reference = aProcessed(kind, "25.00", wallet);
    const refund = aTransaction(Kind.Refund, "25.00", ref(reference.externalTransactionId));

    settle(refund, wallet, { reference });

    expect(refund.status).toBe(Status.Rejected);
    expect(refund.failureCode).toBe(FailureCode.ReferenceInvalidKind);
  });

  test("does not reverse the same BET twice", () => {
    const wallet = aWallet("100.00");
    const bet = aProcessed(Kind.Bet, "25.00", wallet);
    const refund = aTransaction(Kind.Refund, "25.00", ref(bet.externalTransactionId));

    const { entry } = settle(refund, wallet, { reference: bet, referenceAlreadyReversed: true });

    expect(refund.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(entry).toBeUndefined();
    expect(wallet.balance.equals(brl("75.00"))).toBe(true);
  });

  test("requires the same amount as the reference", () => {
    const wallet = aWallet("100.00");
    const bet = aProcessed(Kind.Bet, "25.00", wallet);
    const refund = aTransaction(Kind.Refund, "10.00", ref(bet.externalTransactionId));

    settle(refund, wallet, { reference: bet });

    expect(refund.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
  });

  test("is still allowed after a WIN in the same round", () => {
    const wallet = aWallet("100.00");
    const bet = aProcessed(Kind.Bet, "10.00", wallet);
    aProcessed(Kind.Win, "50.00", wallet);
    const refund = aTransaction(Kind.Refund, "10.00", ref(bet.externalTransactionId));

    settle(refund, wallet, { reference: bet });

    expect(refund.status).toBe(Status.Processed);
    expect(wallet.balance.equals(brl("150.00"))).toBe(true);
  });
});

describe("ROLLBACK", () => {
  test("of a BET credits", () => {
    const wallet = aWallet("100.00");
    const bet = aProcessed(Kind.Bet, "25.00", wallet);
    const rollback = aTransaction(Kind.Rollback, "25.00", ref(bet.externalTransactionId));

    const { entry } = settle(rollback, wallet, { reference: bet });

    expect(rollback.status).toBe(Status.Processed);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.equals(brl("100.00"))).toBe(true);
  });

  test("of a WIN debits", () => {
    const wallet = aWallet("100.00");
    const win = aProcessed(Kind.Win, "25.00", wallet);
    const rollback = aTransaction(Kind.Rollback, "25.00", ref(win.externalTransactionId));

    const { entry } = settle(rollback, wallet, { reference: win });

    expect(entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.equals(brl("100.00"))).toBe(true);
  });

  test("of a REFUND debits", () => {
    const wallet = aWallet("100.00");
    const bet = aProcessed(Kind.Bet, "25.00", wallet);
    const refund = aTransaction(Kind.Refund, "25.00", ref(bet.externalTransactionId));
    settle(refund, wallet, { reference: bet });
    const rollback = aTransaction(Kind.Rollback, "25.00", ref(refund.externalTransactionId));

    settle(rollback, wallet, { reference: refund });

    expect(rollback.status).toBe(Status.Processed);
    expect(wallet.balance.equals(brl("75.00"))).toBe(true);
  });

  test("cannot reference LOSS or another ROLLBACK", () => {
    const wallet = aWallet("100.00");
    const loss = aProcessed(Kind.Loss, "25.00", wallet);
    const bet = aProcessed(Kind.Bet, "25.00", wallet);
    const first = aTransaction(Kind.Rollback, "25.00", ref(bet.externalTransactionId));
    settle(first, wallet, { reference: bet });

    const ofLoss = aTransaction(Kind.Rollback, "25.00", ref(loss.externalTransactionId));
    const ofRollback = aTransaction(Kind.Rollback, "25.00", ref(first.externalTransactionId));
    settle(ofLoss, wallet, { reference: loss });
    settle(ofRollback, wallet, { reference: first });

    expect(ofLoss.failureCode).toBe(FailureCode.ReferenceInvalidKind);
    expect(ofRollback.failureCode).toBe(FailureCode.ReferenceInvalidKind);
  });

  test("that would make the balance negative uses a code distinct from a BET without funds", () => {
    const wallet = aWallet("0.00");
    const win = aProcessed(Kind.Win, "50.00", wallet);
    aProcessed(Kind.Bet, "40.00", wallet);
    const rollback = aTransaction(Kind.Rollback, "50.00", ref(win.externalTransactionId));

    const { entry } = settle(rollback, wallet, { reference: win });

    expect(rollback.status).toBe(Status.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(rollback.failureCode).not.toBe(FailureCode.InsufficientFunds);
    expect(entry).toBeUndefined();
    expect(wallet.balance.equals(brl("10.00"))).toBe(true);
  });

  test("does not reverse twice", () => {
    const wallet = aWallet("100.00");
    const bet = aProcessed(Kind.Bet, "25.00", wallet);
    const rollback = aTransaction(Kind.Rollback, "25.00", ref(bet.externalTransactionId));

    settle(rollback, wallet, { reference: bet, referenceAlreadyReversed: true });

    expect(rollback.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
  });

  test("requires the same amount", () => {
    const wallet = aWallet("100.00");
    const bet = aProcessed(Kind.Bet, "25.00", wallet);
    const rollback = aTransaction(Kind.Rollback, "24.99", ref(bet.externalTransactionId));

    settle(rollback, wallet, { reference: bet });

    expect(rollback.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
  });
});

describe("reference validation", () => {
  test.each([
    ["provider", { providerId: "provider-b" }],
    ["player", { playerId: "player-2" }],
    ["wallet", { walletId: "wallet-2" }],
    ["round", { roundId: "round-2" }],
  ])("rejects a reference from another %s", (_, overrides) => {
    const wallet = aWallet("100.00");
    const reference = aTransaction(Kind.Bet, "25.00", overrides);
    reference.markProcessed(undefined, NOW, brl("75.00"));
    const refund = aTransaction(Kind.Refund, "25.00", ref(reference.externalTransactionId));

    settle(refund, wallet, { reference });

    expect(refund.failureCode).toBe(FailureCode.ReferenceMismatch);
  });

  test("rejects a reference whose external id differs from the declared one", () => {
    const wallet = aWallet("100.00");
    const bet = aProcessed(Kind.Bet, "25.00", wallet);
    const refund = aTransaction(Kind.Refund, "25.00", ref("tx-other"));

    const { entry } = settle(refund, wallet, { reference: bet });

    expect(refund.failureCode).toBe(FailureCode.ReferenceMismatch);
    expect(entry).toBeUndefined();
    expect(wallet.balance.equals(brl("75.00"))).toBe(true);
  });

  test("rejects a reference in another currency", () => {
    const wallet = aWallet("100.00");
    const reference = aTransaction(Kind.Bet, "25.00", { money: Money.from({ amount: "25.00", currency: "USD" }) });
    reference.markProcessed(undefined, NOW, brl("75.00"));
    const refund = aTransaction(Kind.Refund, "25.00", ref(reference.externalTransactionId));

    settle(refund, wallet, { reference });

    expect(refund.failureCode).toBe(FailureCode.ReferenceMismatch);
  });

  test("rejects a REJECTED reference", () => {
    const wallet = aWallet("1.00");
    const bet = aProcessed(Kind.Bet, "50.00", wallet);
    const refund = aTransaction(Kind.Refund, "50.00", ref(bet.externalTransactionId));

    settle(refund, wallet, { reference: bet });

    expect(bet.status).toBe(Status.Rejected);
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });
});

describe("out-of-order references", () => {
  test("ROLLBACK before its BET waits and is applied later", () => {
    const wallet = aWallet("100.00");
    const rollback = aTransaction(Kind.Rollback, "25.00", ref("tx-bet"));

    settle(rollback, wallet);
    expect(rollback.status).toBe(Status.PendingReference);
    expect(wallet.balance.equals(brl("100.00"))).toBe(true);

    const bet = aTransaction(Kind.Bet, "25.00", { externalTransactionId: "tx-bet" });
    settle(bet, wallet);
    settle(rollback, wallet, { reference: bet });

    expect(rollback.status).toBe(Status.Processed);
    expect(wallet.balance.equals(brl("100.00"))).toBe(true);
  });

  test("a still pending reference keeps the dependent waiting", () => {
    const wallet = aWallet("100.00");
    const refund = aTransaction(Kind.Refund, "25.00", ref("tx-bet"));
    settle(refund, wallet);
    const rollback = aTransaction(Kind.Rollback, "25.00", ref(refund.externalTransactionId));

    settle(rollback, wallet, { reference: refund });

    expect(rollback.status).toBe(Status.PendingReference);
  });

  test("a new attempt without a reference schedules the next retry", () => {
    const wallet = aWallet("100.00");
    const refund = aTransaction(Kind.Refund, "25.00", ref("tx-bet"));
    settle(refund, wallet);

    settle(refund, wallet);

    expect(refund.status).toBe(Status.PendingReference);
    expect(refund.referenceAttempts).toBe(1);
  });

  test("once the limit is exhausted becomes REJECTED with REFERENCE_NOT_FOUND", () => {
    const wallet = aWallet("100.00");
    const refund = aTransaction(Kind.Refund, "25.00", ref("tx-bet"));
    settle(refund, wallet);

    for (let attempt = 0; attempt < 11; attempt += 1) settle(refund, wallet);
    expect(refund.status).toBe(Status.PendingReference);
    settle(refund, wallet);

    expect(refund.status).toBe(Status.Rejected);
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(refund.resultBalance?.equals(brl("100.00"))).toBe(true);
  });

  test("a reference that never settles is exhausted with REFERENCE_NOT_PROCESSED", () => {
    const wallet = aWallet("100.00");
    const refund = aTransaction(Kind.Refund, "25.00", ref("tx-bet"));
    settle(refund, wallet);
    const rollback = aTransaction(Kind.Rollback, "25.00", ref(refund.externalTransactionId));
    settle(rollback, wallet, { reference: refund });

    for (let attempt = 0; attempt < 12; attempt += 1) settle(rollback, wallet, { reference: refund });

    expect(rollback.failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });
});

describe("terminal states", () => {
  test("settling a processed BET again neither debits nor increments version", () => {
    const wallet = aWallet("100.00");
    const bet = aProcessed(Kind.Bet, "20.00", wallet);

    expect(() => settle(bet, wallet)).toThrow(InvalidTransactionStateError);

    expect(wallet.balance.equals(brl("80.00"))).toBe(true);
    expect(wallet.version).toBe(2);
  });

  test("settling a rejected BET again changes nothing", () => {
    const wallet = aWallet("10.00");
    const bet = aProcessed(Kind.Bet, "20.00", wallet);

    expect(() => settle(bet, wallet)).toThrow(InvalidTransactionStateError);

    expect(bet.status).toBe(Status.Rejected);
    expect(wallet.version).toBe(1);
  });

  test("a reference given to a transaction without one is a programming error", () => {
    const wallet = aWallet("100.00");
    const bet = aProcessed(Kind.Bet, "20.00", wallet);

    expect(() => settle(aTransaction(Kind.Win, "5.00"), wallet, { reference: bet })).toThrow(InvalidTransactionError);
    expect(wallet.version).toBe(2);
  });
});

describe("wallet ownership", () => {
  test("a player other than the owner becomes REJECTED", () => {
    const wallet = aWallet();
    const bet = aTransaction(Kind.Bet, "1.00", { playerId: "other" });

    settle(bet, wallet);

    expect(bet.failureCode).toBe(FailureCode.PlayerWalletMismatch);
    expect(wallet.version).toBe(1);
  });

  test("a currency other than the wallet's becomes REJECTED", () => {
    const wallet = aWallet();
    const bet = aTransaction(Kind.Bet, "1.00", { money: Money.from({ amount: "1.00", currency: "USD" }) });

    settle(bet, wallet);

    expect(bet.status).toBe(Status.Rejected);
    expect(bet.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(wallet.version).toBe(1);
  });

  test("a transaction from another wallet is a programming error", () => {
    const other = Wallet.open({ id: "other", playerId: PLAYER_ID, initialBalance: brl("1.00"), at: NOW });

    expect(() => settle(aTransaction(Kind.Bet, "1.00"), other)).toThrow(InvalidTransactionError);
  });

  test("every balance change has exactly one ledger entry", () => {
    const wallet = aWallet("100.00");
    const entries = [
      settle(aTransaction(Kind.Bet, "30.00"), wallet).entry,
      settle(aTransaction(Kind.Win, "10.00"), wallet).entry,
      settle(aTransaction(Kind.Loss, "5.00"), wallet).entry,
      settle(aTransaction(Kind.Bet, "1000.00"), wallet).entry,
    ].filter((entry) => entry !== undefined);

    const rebuilt = entries.reduce(
      (balance, entry) =>
        entry.direction === LedgerDirection.Credit ? balance.add(entry.money) : balance.subtract(entry.money),
      brl("100.00"),
    );

    expect(entries).toHaveLength(2);
    expect(rebuilt.equals(wallet.balance)).toBe(true);
    expect(wallet.version).toBe(3);
  });
});
