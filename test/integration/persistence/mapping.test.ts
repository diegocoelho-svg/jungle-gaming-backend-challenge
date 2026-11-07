import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { InboxMessage } from "../../../src/wagering/domain/entities/inbox-message.entity";
import { OutboxMessage } from "../../../src/wagering/domain/entities/outbox-message.entity";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../src/wagering/domain/entities/wager-transaction.entity";
import { WagerTransactionProcessed } from "../../../src/wagering/domain/events/wager-transaction-processed.event";
import { FailureCode } from "../../../src/wagering/domain/errors/failure-code";
import { settleTransaction } from "../../../src/wagering/domain/services/settle-transaction.service";
import {
  inboxMessageToDomain,
  inboxMessageToSchema,
  outboxMessageToDomain,
  outboxMessageToSchema,
} from "../../../src/wagering/infrastructure/persistence/mappers/message.mapper";
import {
  ledgerEntryToDomain,
  ledgerEntryToSchema,
} from "../../../src/wagering/infrastructure/persistence/mappers/wallet-ledger-entry.mapper";
import { walletToDomain, walletToSchema } from "../../../src/wagering/infrastructure/persistence/mappers/wallet.mapper";
import {
  wagerTransactionToDomain,
  wagerTransactionToSchema,
} from "../../../src/wagering/infrastructure/persistence/mappers/wager-transaction.mapper";
import { InboxMessageSchema } from "../../../src/wagering/infrastructure/persistence/schemas/inbox-message.schema";
import { OutboxMessageSchema } from "../../../src/wagering/infrastructure/persistence/schemas/outbox-message.schema";
import { WagerTransactionSchema } from "../../../src/wagering/infrastructure/persistence/schemas/wager-transaction.schema";
import { WalletLedgerEntrySchema } from "../../../src/wagering/infrastructure/persistence/schemas/wallet-ledger-entry.schema";
import { WalletSchema } from "../../../src/wagering/infrastructure/persistence/schemas/wallet.schema";
import { brl, createTestOrm, id, persistOpenedWallet, resetSchema } from "../../support/database";

let orm: MikroORM;

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
});

afterAll(async () => {
  await orm.close();
});

const loadWallet = async (walletId: string) =>
  walletToDomain(await orm.em.fork().findOneOrFail(WalletSchema, walletId));
const loadTransaction = async (transactionId: string) =>
  wagerTransactionToDomain(await orm.em.fork().findOneOrFail(WagerTransactionSchema, transactionId));

function aTransaction(
  walletId: string,
  playerId: string,
  kind: WagerTransactionKind,
  amount: string,
  reference?: string,
) {
  const externalTransactionId = id();

  return WagerTransaction.create({
    id: id(),
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: "b".repeat(64),
    walletId,
    playerId,
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: brl(amount),
    ...(reference && { referenceExternalTransactionId: reference }),
    createdAt: new Date(),
  });
}

async function settleAndPersist(walletId: string, transaction: WagerTransaction, reference?: WagerTransaction) {
  await orm.em.fork().transactional(async (em) => {
    const walletRow = await em.findOneOrFail(WalletSchema, walletId);
    const wallet = walletToDomain(walletRow);

    const { entry } = settleTransaction({
      transaction,
      wallet,
      ...(reference && { reference }),
      referenceAlreadyReversed: false,
      ledgerEntryId: id(),
      at: new Date(),
    });

    walletToSchema(wallet, walletRow);
    em.persist(wagerTransactionToSchema(transaction));
    if (entry) em.persist(ledgerEntryToSchema(entry));
  });
}

describe("wallet opening", () => {
  test("round-trips the wallet, the OPENING transaction and its entry", async () => {
    const opened = await persistOpenedWallet(orm, "1000.00");

    const wallet = await loadWallet(opened.wallet.id);
    const opening = await loadTransaction(opened.opening?.transaction.id ?? "");
    const entry = ledgerEntryToDomain(
      await orm.em.fork().findOneOrFail(WalletLedgerEntrySchema, { walletId: opened.wallet.id }),
    );

    expect(wallet.balance.equals(brl("1000.00"))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(opening.kind).toBe(WagerTransactionKind.Opening);
    expect(opening.status).toBe(WagerTransactionStatus.Processed);
    expect(opening.resultBalance?.equals(brl("1000.00"))).toBe(true);
    expect(entry.isBalanced()).toBe(true);
    expect(entry.walletVersion).toBe(1);
  });

  test("a zero balance wallet stores no transaction", async () => {
    const opened = await persistOpenedWallet(orm, "0.00");

    expect(await orm.em.fork().count(WagerTransactionSchema, { walletId: opened.wallet.id })).toBe(0);
  });
});

describe("settled transactions", () => {
  test("a processed BET persists the new balance, version and entry", async () => {
    const opened = await persistOpenedWallet(orm, "100.00");
    const bet = aTransaction(opened.wallet.id, opened.wallet.playerId, WagerTransactionKind.Bet, "25.00");

    await settleAndPersist(opened.wallet.id, bet);

    const wallet = await loadWallet(opened.wallet.id);
    const stored = await loadTransaction(bet.id);
    expect(wallet.balance.equals(brl("75.00"))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(stored.status).toBe(WagerTransactionStatus.Processed);
    expect(stored.resultBalance?.equals(brl("75.00"))).toBe(true);
  });

  test("a rejected BET persists the failure code and the observed balance, without an entry", async () => {
    const opened = await persistOpenedWallet(orm, "10.00");
    const bet = aTransaction(opened.wallet.id, opened.wallet.playerId, WagerTransactionKind.Bet, "25.00");

    await settleAndPersist(opened.wallet.id, bet);

    const stored = await loadTransaction(bet.id);
    expect(stored.status).toBe(WagerTransactionStatus.Rejected);
    expect(stored.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(stored.resultBalance?.equals(brl("10.00"))).toBe(true);
    expect(await orm.em.fork().count(WalletLedgerEntrySchema, { walletId: opened.wallet.id })).toBe(1);
  });

  test("a pending reference persists its schedule and can be settled later", async () => {
    const opened = await persistOpenedWallet(orm, "100.00");
    const bet = aTransaction(opened.wallet.id, opened.wallet.playerId, WagerTransactionKind.Bet, "25.00");
    const rollback = aTransaction(
      opened.wallet.id,
      opened.wallet.playerId,
      WagerTransactionKind.Rollback,
      "25.00",
      bet.externalTransactionId,
    );

    await settleAndPersist(opened.wallet.id, rollback);
    const pending = await loadTransaction(rollback.id);
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    expect(pending.nextReferenceAttemptAt).toBeInstanceOf(Date);

    await settleAndPersist(opened.wallet.id, bet);
    await orm.em.fork().transactional(async (em) => {
      const walletRow = await em.findOneOrFail(WalletSchema, opened.wallet.id);
      const rollbackRow = await em.findOneOrFail(WagerTransactionSchema, rollback.id);
      const wallet = walletToDomain(walletRow);
      const transaction = wagerTransactionToDomain(rollbackRow);

      const { entry } = settleTransaction({
        transaction,
        wallet,
        reference: await loadTransaction(bet.id),
        referenceAlreadyReversed: false,
        ledgerEntryId: id(),
        at: new Date(),
      });

      walletToSchema(wallet, walletRow);
      wagerTransactionToSchema(transaction, rollbackRow);
      if (entry) em.persist(ledgerEntryToSchema(entry));
    });

    const settled = await loadTransaction(rollback.id);
    expect(settled.status).toBe(WagerTransactionStatus.Processed);
    expect(settled.referenceTransactionId).toBe(bet.id);
    expect((await loadWallet(opened.wallet.id)).balance.equals(brl("100.00"))).toBe(true);
  });
});

describe("money in the database", () => {
  test.each(["0.01", "0.10", "999999999999999999.99"])("keeps %s exact", async (amount) => {
    const opened = await persistOpenedWallet(orm, amount);

    expect((await loadWallet(opened.wallet.id)).balance.toJSON().amount).toBe(amount);
  });

  test("ledger aggregates come back as exact strings", async () => {
    const opened = await persistOpenedWallet(orm, "0.10");
    const win = aTransaction(opened.wallet.id, opened.wallet.playerId, WagerTransactionKind.Win, "0.20");
    await settleAndPersist(opened.wallet.id, win);

    const [row] = await orm.em
      .getConnection()
      .execute(
        "select sum(case direction when 'CREDIT' then amount else -amount end) as total from wallet_ledger_entries where wallet_id = ?",
        [opened.wallet.id],
      );

    expect(row?.total).toBe("0.30");
    expect(typeof row?.total).toBe("string");
  });
});

describe("messages", () => {
  test("an inbox message round-trips", async () => {
    const message = InboxMessage.receive({
      consumerName: "wagers",
      messageId: id(),
      payloadHash: "c".repeat(64),
      receivedAt: new Date(),
    });
    message.markProcessed(new Date());

    await orm.em.fork().transactional(async (em) => {
      em.persist(inboxMessageToSchema(message));
    });
    const stored = inboxMessageToDomain(
      await orm.em.fork().findOneOrFail(InboxMessageSchema, { consumerName: "wagers", messageId: message.messageId }),
    );

    expect(stored.isProcessed()).toBe(true);
    expect(stored.matchesPayload("c".repeat(64))).toBe(true);
  });

  test("an outbox message keeps its JSON envelope", async () => {
    const opened = await persistOpenedWallet(orm, "100.00");
    const event = WagerTransactionProcessed.from(opened.opening?.transaction as WagerTransaction, {
      eventId: id(),
      correlationId: "corr-1",
      occurredAt: new Date(),
    });
    const message = OutboxMessage.enqueue(event);

    await orm.em.fork().transactional(async (em) => {
      em.persist(outboxMessageToSchema(message));
    });
    const stored = outboxMessageToDomain(await orm.em.fork().findOneOrFail(OutboxMessageSchema, message.id));

    expect(stored.payload).toEqual(JSON.parse(JSON.stringify(event.toJSON())));
    expect(stored.isPending()).toBe(true);
  });
});
