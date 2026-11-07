import { describe, expect, test } from "bun:test";
import { InboxMessage } from "../../../src/wagering/domain/entities/inbox-message.entity";
import { OutboxMessage } from "../../../src/wagering/domain/entities/outbox-message.entity";
import { LedgerDirection } from "../../../src/wagering/domain/entities/wallet-ledger-entry.entity";
import { WagerTransactionKind as Kind } from "../../../src/wagering/domain/entities/wager-transaction.entity";
import {
  InvalidMessageStateError,
  InvalidTransactionStateError,
} from "../../../src/wagering/domain/errors/domain.error";
import { FailureCode } from "../../../src/wagering/domain/errors/failure-code";
import { WagerTransactionPendingReference } from "../../../src/wagering/domain/events/wager-transaction-pending-reference.event";
import { WagerTransactionProcessed } from "../../../src/wagering/domain/events/wager-transaction-processed.event";
import { WagerTransactionRejected } from "../../../src/wagering/domain/events/wager-transaction-rejected.event";
import { WalletBalanceChanged } from "../../../src/wagering/domain/events/wallet-balance-changed.event";
import { aTransaction, aWallet, brl, NOW, settle, WALLET_ID } from "./fixtures";

const context = { eventId: "event-1", correlationId: "corr-1", causationId: "msg-1", occurredAt: NOW };
const secondsFromNow = (date: Date | undefined) => ((date?.getTime() ?? 0) - NOW.getTime()) / 1_000;

const processedEvent = () => {
  const transaction = aTransaction(Kind.Bet, "25.00");
  settle(transaction, aWallet());
  return WagerTransactionProcessed.from(transaction, context);
};

describe("InboxMessage", () => {
  const receive = () =>
    InboxMessage.receive({ messageId: "m-1", consumerName: "wagers", payloadHash: "hash", receivedAt: NOW });

  test("starts unprocessed", () => {
    expect(receive().isProcessed()).toBe(false);
  });

  test("marks as processed only once", () => {
    const message = receive();

    message.markProcessed(NOW);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(NOW);
    expect(() => message.markProcessed(NOW)).toThrow(InvalidMessageStateError);
  });

  test("compares the payload hash", () => {
    expect(receive().matchesPayload("hash")).toBe(true);
    expect(receive().matchesPayload("other")).toBe(false);
  });

  test("rehydrate keeps the state", () => {
    const message = InboxMessage.rehydrate({
      messageId: "m",
      consumerName: "c",
      payloadHash: "h",
      receivedAt: NOW,
      processedAt: NOW,
    });

    expect(message.isProcessed()).toBe(true);
  });
});

describe("OutboxMessage", () => {
  test("enqueue stores the serialized event envelope", () => {
    const event = processedEvent();

    const message = OutboxMessage.enqueue(event);

    expect(message.id).toBe(event.eventId);
    expect(message.aggregateId).toBe(WALLET_ID);
    expect(message.eventType).toBe("WagerTransactionProcessed");
    expect(message.payload).toEqual({ ...event.toJSON() });
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(NOW)).toBe(true);
  });

  test("retry applies capped backoff without giving up", () => {
    const message = OutboxMessage.enqueue(processedEvent());
    const delays: number[] = [];

    for (let attempt = 0; attempt < 11; attempt += 1) {
      message.scheduleRetry(NOW);
      delays.push(secondsFromNow(message.nextAttemptAt));
    }

    expect(delays).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300]);
    expect(message.attempts).toBe(11);
    expect(message.isPending()).toBe(true);
  });

  test("isDue respects the next attempt time", () => {
    const message = OutboxMessage.enqueue(processedEvent());

    message.scheduleRetry(NOW);

    expect(message.isDue(NOW)).toBe(false);
    expect(message.isDue(new Date(NOW.getTime() + 1_000))).toBe(true);
  });

  test("published is no longer pending", () => {
    const message = OutboxMessage.enqueue(processedEvent());

    message.markPublished(NOW);

    expect(message.isPending()).toBe(false);
    expect(message.isDue(NOW)).toBe(false);
    expect(message.publishedAt).toEqual(NOW);
    expect(() => message.markPublished(NOW)).toThrow(InvalidMessageStateError);
    expect(() => message.scheduleRetry(NOW)).toThrow(InvalidMessageStateError);
  });

  test("rehydrate keeps attempts", () => {
    const message = OutboxMessage.rehydrate({
      id: "e",
      aggregateId: "w",
      eventType: "X",
      payload: {},
      occurredAt: NOW,
      attempts: 4,
      nextAttemptAt: NOW,
    });

    expect(message.attempts).toBe(4);
  });
});

describe("integration events", () => {
  test("envelope is stable, versioned JSON", () => {
    const envelope = processedEvent().toJSON();

    expect(envelope).toMatchObject({
      eventId: "event-1",
      eventType: "WagerTransactionProcessed",
      aggregateId: WALLET_ID,
      correlationId: "corr-1",
      causationId: "msg-1",
      occurredAt: NOW.toISOString(),
      version: 1,
    });
    expect(typeof envelope.occurredAt).toBe("string");
    expect(JSON.parse(JSON.stringify(envelope)).data.money).toEqual({ amount: "25.00", currency: "BRL" });
  });

  test("causationId is optional", () => {
    const transaction = aTransaction(Kind.Bet, "1.00");
    settle(transaction, aWallet());
    const { causationId: _, ...withoutCausation } = context;

    expect("causationId" in WagerTransactionProcessed.from(transaction, withoutCausation).toJSON()).toBe(false);
  });

  test("processed carries MoneyProps, never Money", () => {
    const { data } = processedEvent();

    expect(data.money).toEqual({ amount: "25.00", currency: "BRL" });
    expect(data.balance).toEqual({ amount: "75.00", currency: "BRL" });
  });

  test("processed also covers LOSS", () => {
    const loss = aTransaction(Kind.Loss, "5.00");
    settle(loss, aWallet());

    expect(WagerTransactionProcessed.from(loss, context).data.kind).toBe(Kind.Loss);
  });

  test("rejected carries the failureCode", () => {
    const bet = aTransaction(Kind.Bet, "500.00");
    settle(bet, aWallet());

    const event = WagerTransactionRejected.from(bet, context);

    expect(event.eventType).toBe("WagerTransactionRejected");
    expect(event.data.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test("pending reference carries the external reference", () => {
    const refund = aTransaction(Kind.Refund, "5.00", { referenceExternalTransactionId: "tx-0" });
    settle(refund, aWallet());

    const event = WagerTransactionPendingReference.from(refund, context);

    expect(event.eventType).toBe("WagerTransactionPendingReference");
    expect(event.data.referenceExternalTransactionId).toBe("tx-0");
  });

  test("transaction events require the matching status", () => {
    const pending = aTransaction(Kind.Bet, "1.00");
    const processed = aTransaction(Kind.Bet, "1.00");
    settle(processed, aWallet());

    expect(() => WagerTransactionProcessed.from(pending, context)).toThrow(InvalidTransactionStateError);
    expect(() => WagerTransactionRejected.from(pending, context)).toThrow(InvalidTransactionStateError);
    expect(() => WagerTransactionRejected.from(processed, context)).toThrow(InvalidTransactionStateError);
    expect(() => WagerTransactionPendingReference.from(pending, context)).toThrow(InvalidTransactionStateError);
  });

  test("balance changed mirrors the entry", () => {
    const wallet = aWallet("100.00");
    const { entry } = settle(aTransaction(Kind.Bet, "25.00"), wallet);
    if (!entry) throw new Error("should create an entry");

    const event = WalletBalanceChanged.from(wallet, entry, context);

    expect(event.eventType).toBe("WalletBalanceChanged");
    expect(event.aggregateId).toBe(wallet.id);
    expect(event.data).toEqual({
      walletId: wallet.id,
      transactionId: entry.transactionId,
      direction: LedgerDirection.Debit,
      money: brl("25.00").toJSON(),
      balanceBefore: brl("100.00").toJSON(),
      balanceAfter: brl("75.00").toJSON(),
      walletVersion: 2,
    });
  });
});
