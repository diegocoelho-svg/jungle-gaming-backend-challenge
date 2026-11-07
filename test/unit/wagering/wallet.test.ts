import { describe, expect, test } from "bun:test";
import { LedgerDirection, WalletLedgerEntry } from "../../../src/wagering/domain/entities/wallet-ledger-entry.entity";
import { BalanceMovementFailure, Wallet } from "../../../src/wagering/domain/entities/wallet.entity";
import { WagerTransactionKind } from "../../../src/wagering/domain/entities/wager-transaction.entity";
import {
  CurrencyMismatchError,
  InvalidLedgerEntryError,
  InvalidWalletError,
} from "../../../src/wagering/domain/errors/domain.error";
import { openWallet } from "../../../src/wagering/domain/services/open-wallet.service";
import { Money } from "../../../src/wagering/domain/value-objects/money.vo";
import { aWallet, brl, NOW } from "./fixtures";

const LATER = new Date("2026-11-07T13:00:00.000Z");
const movement = (amount: string) => ({ entryId: "e-1", transactionId: "t-1", money: brl(amount), at: LATER });

describe("Wallet.open", () => {
  test("starts at version 1", () => {
    const wallet = aWallet("1000.00");

    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe("BRL");
    expect(wallet.balance.equals(brl("1000.00"))).toBe(true);
  });

  test("rejects a negative initial balance", () => {
    expect(() =>
      Wallet.open({
        id: "w",
        playerId: "p",
        initialBalance: Money.rehydrate({ amount: "-1.00", currency: "BRL" }),
        at: NOW,
      }),
    ).toThrow(InvalidWalletError);
  });
});

describe("Wallet.debit", () => {
  test("reduces the balance, increments version and creates a consistent entry", () => {
    const wallet = aWallet("100.00");

    const result = wallet.debit(movement("25.00"));

    expect(result.applied).toBe(true);
    expect(wallet.balance.equals(brl("75.00"))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(LATER);
    if (!result.applied) throw new Error("should apply");
    expect(result.entry.direction).toBe(LedgerDirection.Debit);
    expect(result.entry.balanceBefore.equals(brl("100.00"))).toBe(true);
    expect(result.entry.balanceAfter.equals(brl("75.00"))).toBe(true);
    expect(result.entry.walletVersion).toBe(2);
    expect(result.entry.isBalanced()).toBe(true);
  });

  test("allows the balance to reach zero", () => {
    const wallet = aWallet("10.00");

    expect(wallet.debit(movement("10.00")).applied).toBe(true);
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("insufficient funds change nothing", () => {
    const wallet = aWallet("10.00");

    const result = wallet.debit(movement("10.01"));

    expect(result).toEqual({ applied: false, failure: BalanceMovementFailure.InsufficientFunds });
    expect(wallet.balance.equals(brl("10.00"))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(NOW);
  });
});

describe("Wallet.credit", () => {
  test("increases the balance and creates an entry", () => {
    const wallet = aWallet("10.00");

    const result = wallet.credit(movement("5.50"));

    expect(wallet.balance.equals(brl("15.50"))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(result.applied && result.entry.direction).toBe(LedgerDirection.Credit);
  });

  test("above the column limit changes nothing", () => {
    const wallet = aWallet("999999999999999999.99");

    const result = wallet.credit(movement("0.01"));

    expect(result).toEqual({ applied: false, failure: BalanceMovementFailure.LimitExceeded });
    expect(wallet.version).toBe(1);
  });
});

describe("movement guards", () => {
  test.each(["debit", "credit"] as const)("%s rejects a zero amount", (operation) => {
    expect(() => aWallet()[operation](movement("0.00"))).toThrow(InvalidWalletError);
  });

  test.each(["debit", "credit"] as const)("%s rejects a different currency", (operation) => {
    const money = Money.from({ amount: "1.00", currency: "USD" });

    expect(() => aWallet()[operation]({ ...movement("1.00"), money })).toThrow(CurrencyMismatchError);
  });
});

describe("Wallet.rehydrate", () => {
  test("rebuilds state without revalidating", () => {
    const wallet = Wallet.rehydrate({
      id: "w",
      playerId: "p",
      currency: "BRL",
      balance: brl("5.00"),
      version: 7,
      createdAt: NOW,
      updatedAt: LATER,
    });

    expect(wallet.version).toBe(7);
    expect(wallet.updatedAt).toEqual(LATER);
  });
});

describe("openWallet", () => {
  const input = {
    walletId: "w-1",
    playerId: "p-1",
    openingTransactionId: "t-1",
    openingEntryId: "e-1",
    at: NOW,
  };

  test("a positive balance creates OPENING and CREDIT without incrementing version", () => {
    const { wallet, opening } = openWallet({ ...input, initialBalance: brl("1000.00") });

    expect(wallet.version).toBe(1);
    expect(opening?.transaction.kind).toBe(WagerTransactionKind.Opening);
    expect(opening?.transaction.isTerminal()).toBe(true);
    expect(opening?.transaction.resultBalance?.equals(brl("1000.00"))).toBe(true);
    expect(opening?.entry.direction).toBe(LedgerDirection.Credit);
    expect(opening?.entry.balanceBefore.isZero()).toBe(true);
    expect(opening?.entry.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(opening?.entry.walletVersion).toBe(1);
  });

  test("a zero balance creates no transaction or entry", () => {
    expect(openWallet({ ...input, initialBalance: brl("0.00") }).opening).toBeUndefined();
  });
});

describe("WalletLedgerEntry", () => {
  const entry = {
    id: "e",
    walletId: "w",
    transactionId: "t",
    direction: LedgerDirection.Debit,
    money: brl("10.00"),
    balanceBefore: brl("100.00"),
    balanceAfter: brl("90.00"),
    walletVersion: 2,
    createdAt: NOW,
  };

  test("accepts correct arithmetic", () => {
    expect(WalletLedgerEntry.create(entry).isBalanced()).toBe(true);
  });

  test("rejects incorrect arithmetic", () => {
    expect(() => WalletLedgerEntry.create({ ...entry, balanceAfter: brl("91.00") })).toThrow(InvalidLedgerEntryError);
  });

  test("rejects a direction that does not add up", () => {
    expect(() => WalletLedgerEntry.create({ ...entry, direction: LedgerDirection.Credit })).toThrow(
      InvalidLedgerEntryError,
    );
  });

  test("rejects a zero amount", () => {
    expect(() => WalletLedgerEntry.create({ ...entry, money: brl("0.00"), balanceAfter: brl("100.00") })).toThrow(
      InvalidLedgerEntryError,
    );
  });

  test("rejects a negative final balance", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...entry,
        balanceBefore: brl("5.00"),
        balanceAfter: Money.rehydrate({ amount: "-5.00", currency: "BRL" }),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("has no transition methods", () => {
    const methods = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter((name) => name !== "constructor");

    expect(methods).toEqual(["isBalanced"]);
  });
});
