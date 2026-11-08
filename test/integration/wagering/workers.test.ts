import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { INestApplicationContext } from "@nestjs/common";
import { createApiApp } from "../../../src/bootstrap";
import { loadEnv } from "../../../src/core/config/env";
import { EVENT_PUBLISHER, type EventPublisher } from "../../../src/wagering/application/ports/event-publisher.port";
import { PublishOutboxUseCase } from "../../../src/wagering/application/use-cases/publish-outbox.use-case";
import { ResolvePendingReferencesUseCase } from "../../../src/wagering/application/use-cases/resolve-pending-references.use-case";
import { OutboxMessage } from "../../../src/wagering/domain/entities/outbox-message.entity";
import {
  createWallet,
  expectLedgerMatchesBalances,
  startTestApi,
  submit,
  type TestApi,
  wagerBody,
} from "../../support/api";
import { id } from "../../support/database";
import { drain, eventually, purge, startConsumer, testSqs } from "../../support/queue";

const env = loadEnv();
const EVENTS = env.sqs.eventsQueue;

type App = Awaited<ReturnType<typeof createApiApp>>;

let api: TestApi;
let sqs: SQSClient;
let first: App;
let second: App;

async function setupQueues(): Promise<void> {
  const child = Bun.spawn(["bun", "scripts/setup-queues.ts"], { stdout: "ignore", stderr: "inherit" });
  expect(await child.exited).toBe(0);
}

const sql = <T>(query: string, params: unknown[] = []) => api.orm.em.getConnection().execute<T[]>(query, params);

const publishAll = async (app: App) => {
  const useCase = app.get(PublishOutboxUseCase);
  while ((await useCase.publishDue(50)).claimed > 0);
};

const unpublished = async () =>
  (await sql<{ total: number }>("select count(*)::int as total from outbox_messages where published_at is null"))[0]!
    .total;

const eventsIn = async () =>
  (await drain(sqs, EVENTS)).map((message) => ({
    body: JSON.parse(message.Body ?? "{}") as Record<string, unknown> & { data: Record<string, unknown> },
    type: message.MessageAttributes?.eventType?.StringValue,
  }));

const transactionRow = async (externalId: string) =>
  (
    await sql<{
      id: string;
      status: string;
      failure_code: string | null;
      reference_attempts: number;
      next_reference_attempt_at: Date;
    }>(
      "select id, status, failure_code, reference_attempts, next_reference_attempt_at from wager_transactions where external_transaction_id = ?",
      [externalId],
    )
  )[0]!;

const makeDue = (externalId: string) =>
  sql(
    "update wager_transactions set next_reference_attempt_at = now() - interval '1 second' where external_transaction_id = ?",
    [externalId],
  );

function recordPublications(app: App, published: string[]) {
  const publisher = app.get<EventPublisher>(EVENT_PUBLISHER);
  const original = publisher.publish.bind(publisher);
  publisher.publish = async (messages) => {
    const result = await original(messages);
    published.push(...result);
    return result;
  };
  return () => {
    delete (publisher as { publish?: unknown }).publish;
  };
}

beforeAll(async () => {
  await setupQueues();
  api = await startTestApi();
  sqs = testSqs();
  first = await createApiApp(loadEnv({ ...process.env, DB_POOL_MAX: "10" }));
  second = await createApiApp(loadEnv({ ...process.env, DB_POOL_MAX: "10" }));
  await first.init();
  await second.init();
});

afterAll(async () => {
  await first?.close();
  await second?.close();
  sqs?.destroy();
  await api?.close();
});

beforeEach(async () => {
  await sql("update outbox_messages set published_at = now() where published_at is null");
  await purge(sqs, EVENTS);
});

const eventsOfTransaction = async (transactionId: string) =>
  (
    await sql<{ event_type: string }>(
      "select event_type from outbox_messages where payload->'data'->>'transactionId' = ? order by event_type",
      [transactionId],
    )
  ).map((row) => row.event_type);

describe("outbox publisher", () => {
  test("publishes committed events to the events FIFO and marks them published", async () => {
    const wallet = await createWallet(api, "100.00");
    const bet = await submit(
      api,
      wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "30.00" }),
    );

    await publishAll(first);

    const events = await eventsIn();
    const ofBet = events.filter((event) => event.body.aggregateId === wallet.id);
    expect(ofBet.map((event) => event.type).sort()).toEqual([
      "WagerTransactionProcessed",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
      "WalletBalanceChanged",
    ]);
    const processed = ofBet.find(
      (event) => event.type === "WagerTransactionProcessed" && event.body.data.transactionId === bet.body.transactionId,
    )!;
    expect(processed.body.data.money).toEqual({ amount: "30.00", currency: "BRL" });
    expect(typeof processed.body.eventId).toBe("string");
    expect(await unpublished()).toBe(0);
  });

  test("a LOSS publishes WagerTransactionProcessed without WalletBalanceChanged", async () => {
    const wallet = await createWallet(api, "100.00");
    const loss = await submit(
      api,
      wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "LOSS", amount: "0.00" }),
    );

    await publishAll(first);

    const ofLoss = (await eventsIn()).filter((event) => event.body.data.transactionId === loss.body.transactionId);
    expect(ofLoss.map((event) => event.type)).toEqual(["WagerTransactionProcessed"]);
    expect(ofLoss[0]!.body.aggregateId).toBe(wallet.id);
  });

  test("two publishers over the same outbox never send the same event twice", async () => {
    const wallet = await createWallet(api, "1000.00");
    for (let index = 0; index < 30; index += 1) {
      await submit(api, wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "1.00" }));
    }
    const expected = (
      await sql<{ total: number }>("select count(*)::int as total from outbox_messages where published_at is null")
    )[0]!.total;
    const published: string[] = [];
    const restoreFirst = recordPublications(first, published);
    const restoreSecond = recordPublications(second, published);

    try {
      await Promise.all(
        [first, second, first, second].map(async (app) => {
          const useCase = app.get(PublishOutboxUseCase);
          while ((await useCase.publishDue(5)).claimed > 0);
        }),
      );
    } finally {
      restoreFirst();
      restoreSecond();
    }

    expect(published).toHaveLength(expected);
    expect(new Set(published).size).toBe(expected);
    expect(await unpublished()).toBe(0);
  });

  test("a failed publication is kept and retried later with backoff", async () => {
    const wallet = await createWallet(api, "100.00");
    const publisher = first.get<EventPublisher>(EVENT_PUBLISHER);
    publisher.publish = async () => new Set<string>();

    try {
      await first.get(PublishOutboxUseCase).publishDue(50);
    } finally {
      delete (publisher as { publish?: unknown }).publish;
    }

    const rows = await sql<{ attempts: number; due_later: boolean; published_at: Date | null }>(
      "select attempts, next_attempt_at > now() as due_later, published_at from outbox_messages where aggregate_id = ?",
      [wallet.id],
    );
    expect(rows).toEqual([
      { attempts: 1, due_later: true, published_at: null },
      { attempts: 1, due_later: true, published_at: null },
    ]);
    expect((await first.get(PublishOutboxUseCase).publishDue(50)).claimed).toBe(0);

    await sql("update outbox_messages set next_attempt_at = now() where aggregate_id = ?", [wallet.id]);
    await publishAll(second);
    expect(await unpublished()).toBe(0);
  });

  test("events claimed by a publisher that dies before committing are published by another instance", async () => {
    await createWallet(api, "100.00");
    const pending = await unpublished();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let claimed!: () => void;
    const claimedRows = new Promise<void>((resolve) => {
      claimed = resolve;
    });

    const dying = api.orm.em
      .fork()
      .transactional(async (em) => {
        await em
          .getConnection()
          .execute(
            "select id from outbox_messages where published_at is null for update",
            [],
            "all",
            em.getTransactionContext(),
          );
        claimed();
        await held;
        throw new Error("publisher died");
      })
      .catch(() => undefined);

    await claimedRows;
    expect((await second.get(PublishOutboxUseCase).publishDue(50)).claimed).toBe(0);
    release();
    await dying;

    await publishAll(second);
    expect(pending).toBeGreaterThan(0);
    expect(await unpublished()).toBe(0);
  });

  test("publishing the same event twice is deduplicated by its event id", async () => {
    const wallet = await createWallet(api, "100.00");
    const [row] = await sql<{
      id: string;
      aggregate_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      occurred_at: Date;
    }>("select id, aggregate_id, event_type, payload, occurred_at from outbox_messages where aggregate_id = ?", [
      wallet.id,
    ]);
    const message = OutboxMessage.rehydrate({
      id: row!.id,
      aggregateId: row!.aggregate_id,
      eventType: row!.event_type,
      payload: row!.payload,
      occurredAt: row!.occurred_at,
      attempts: 0,
    });
    const publisher = first.get<EventPublisher>(EVENT_PUBLISHER);

    await publisher.publish([message]);
    await publisher.publish([message]);

    const events = (await eventsIn()).filter((event) => event.body.eventId === row!.id);
    expect(events).toHaveLength(1);
  });
});

describe("pending reference worker", () => {
  test("a REFUND that arrived before its BET is settled once the BET exists", async () => {
    const wallet = await createWallet(api, "100.00");
    const betId = id();
    const refundId = id();

    const early = await submit(
      api,
      wagerBody({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: "REFUND",
        amount: "20.00",
        externalTransactionId: refundId,
        referenceExternalTransactionId: betId,
      }),
    );
    await submit(
      api,
      wagerBody({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: "BET",
        amount: "20.00",
        externalTransactionId: betId,
      }),
    );
    await makeDue(refundId);

    const report = await first.get(ResolvePendingReferencesUseCase).resolveDue(20);

    expect(early.status).toBe(202);
    expect(report.resolved).toBeGreaterThanOrEqual(1);
    expect((await transactionRow(refundId)).status).toBe("PROCESSED");
    const [balance] = await sql<{ balance: string }>("select balance from wallets where id = ?", [wallet.id]);
    expect(balance!.balance).toBe("100.00");
    expect(await eventsOfTransaction((await transactionRow(refundId)).id)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    await expectLedgerMatchesBalances(api.orm);
  });

  test("a reference that is still missing is rescheduled with exponential backoff and no event", async () => {
    const wallet = await createWallet(api, "100.00");
    const refundId = id();
    await submit(
      api,
      wagerBody({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: "REFUND",
        amount: "20.00",
        externalTransactionId: refundId,
        referenceExternalTransactionId: id(),
      }),
    );
    await makeDue(refundId);

    await first.get(ResolvePendingReferencesUseCase).resolveDue(20);

    const row = await transactionRow(refundId);
    expect(row.status).toBe("PENDING_REFERENCE");
    expect(row.reference_attempts).toBe(1);
    const [delay] = await sql<{ seconds: number }>(
      "select extract(epoch from next_reference_attempt_at - now())::int as seconds from wager_transactions where id = ?",
      [row.id],
    );
    expect(delay!.seconds).toBeGreaterThanOrEqual(8);
    expect(delay!.seconds).toBeLessThanOrEqual(10);
    expect(await eventsOfTransaction(row.id)).toEqual(["WagerTransactionPendingReference"]);
  });

  test("after the last attempt the transaction is rejected with REFERENCE_NOT_FOUND and the event is published", async () => {
    const wallet = await createWallet(api, "100.00");
    const refundId = id();
    await submit(
      api,
      wagerBody({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: "REFUND",
        amount: "20.00",
        externalTransactionId: refundId,
        referenceExternalTransactionId: id(),
      }),
    );
    await sql("update wager_transactions set reference_attempts = 11 where external_transaction_id = ?", [refundId]);
    await makeDue(refundId);

    await first.get(ResolvePendingReferencesUseCase).resolveDue(20);
    await publishAll(first);

    const row = await transactionRow(refundId);
    expect(row.status).toBe("REJECTED");
    expect(row.failure_code).toBe("REFERENCE_NOT_FOUND");
    const rejected = (await eventsIn()).filter(
      (event) => event.body.data.transactionId === row.id && event.type !== "WagerTransactionPendingReference",
    );
    expect(rejected.map((event) => event.type)).toEqual(["WagerTransactionRejected"]);
    expect(rejected[0]!.body.data.failureCode).toBe("REFERENCE_NOT_FOUND");
  });

  test("transactions that are not due yet are left alone", async () => {
    const wallet = await createWallet(api, "100.00");
    const refundId = id();
    await submit(
      api,
      wagerBody({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: "REFUND",
        amount: "20.00",
        externalTransactionId: refundId,
        referenceExternalTransactionId: id(),
      }),
    );

    await first.get(ResolvePendingReferencesUseCase).resolveDue(20);

    expect((await transactionRow(refundId)).reference_attempts).toBe(0);
  });

  test("two pending refunds of the same bet settle one and reject the other as already reversed", async () => {
    const wallet = await createWallet(api, "100.00");
    const betId = id();
    const refunds = [id(), id()];
    for (const refundId of refunds) {
      await submit(
        api,
        wagerBody({
          walletId: wallet.id,
          playerId: wallet.playerId,
          kind: "REFUND",
          amount: "20.00",
          externalTransactionId: refundId,
          referenceExternalTransactionId: betId,
        }),
      );
    }
    await submit(
      api,
      wagerBody({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: "BET",
        amount: "20.00",
        externalTransactionId: betId,
      }),
    );
    for (const refundId of refunds) await makeDue(refundId);

    await first.get(ResolvePendingReferencesUseCase).resolveDue(20);

    const outcomes = await Promise.all(
      refunds.map(async (refundId) => (await transactionRow(refundId)).failure_code ?? "PROCESSED"),
    );
    expect(outcomes.sort()).toEqual(["PROCESSED", "REFERENCE_ALREADY_REVERSED"]);
    const [balance] = await sql<{ balance: string }>("select balance from wallets where id = ?", [wallet.id]);
    expect(balance!.balance).toBe("100.00");
  });

  test("resolution and new bets on the same wallet never lose an update", async () => {
    const wallet = await createWallet(api, "1000.00");
    const refunds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const betId = id();
      const refundId = id();
      refunds.push(refundId);
      await submit(
        api,
        wagerBody({
          walletId: wallet.id,
          playerId: wallet.playerId,
          kind: "REFUND",
          amount: "10.00",
          externalTransactionId: refundId,
          referenceExternalTransactionId: betId,
        }),
      );
      await submit(
        api,
        wagerBody({
          walletId: wallet.id,
          playerId: wallet.playerId,
          kind: "BET",
          amount: "10.00",
          externalTransactionId: betId,
        }),
      );
      await makeDue(refundId);
    }

    const [report, bets] = await Promise.all([
      first.get(ResolvePendingReferencesUseCase).resolveDue(20),
      Promise.all(
        Array.from({ length: 20 }, () =>
          submit(api, wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "1.00" })),
        ),
      ),
    ]);

    expect(report.resolved).toBe(10);
    expect(bets.every((bet) => bet.status === 200)).toBe(true);
    const [balance] = await sql<{ balance: string }>("select balance from wallets where id = ?", [wallet.id]);
    expect(balance!.balance).toBe("980.00");
    await expectLedgerMatchesBalances(api.orm);
  });

  test("a worker skips a pending reference another worker is holding instead of waiting for it", async () => {
    const pendingOn = async () => {
      const wallet = await createWallet(api, "100.00");
      const betId = id();
      const refundId = id();
      await submit(
        api,
        wagerBody({
          walletId: wallet.id,
          playerId: wallet.playerId,
          kind: "REFUND",
          amount: "10.00",
          externalTransactionId: refundId,
          referenceExternalTransactionId: betId,
        }),
      );
      await submit(
        api,
        wagerBody({
          walletId: wallet.id,
          playerId: wallet.playerId,
          kind: "BET",
          amount: "10.00",
          externalTransactionId: betId,
        }),
      );
      return { wallet, refundId };
    };
    const held = await pendingOn();
    const free = await pendingOn();
    await sql(
      "update wager_transactions set next_reference_attempt_at = now() - interval '2 seconds' where external_transaction_id = ?",
      [held.refundId],
    );
    await makeDue(free.refundId);

    let blocked: Promise<unknown> = Promise.resolve();
    await api.orm.em.fork().transactional(async (em) => {
      await em
        .getConnection()
        .execute("select id from wallets where id = ? for update", [held.wallet.id], "all", em.getTransactionContext());
      blocked = first.get(ResolvePendingReferencesUseCase).resolveDue(1);
      await eventually(
        async () =>
          (
            await sql<{ total: number }>(
              "select count(*)::int as total from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()",
            )
          )[0]!.total,
        (total) => total > 0,
      );

      const started = Date.now();
      const report = await second.get(ResolvePendingReferencesUseCase).resolveDue(10);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(report.resolved).toBe(1);
      expect((await transactionRow(free.refundId)).status).toBe("PROCESSED");
      expect((await transactionRow(held.refundId)).status).toBe("PENDING_REFERENCE");
    });

    expect(await blocked).toEqual({ claimed: 1, resolved: 1, rescheduled: 0 });
    await eventually(
      async () => (await transactionRow(held.refundId)).status,
      (status) => status === "PROCESSED",
    );
  });

  test("two workers resolving the same backlog settle each reversal once", async () => {
    const wallet = await createWallet(api, "1000.00");
    const refunds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const betId = id();
      const refundId = id();
      refunds.push(refundId);
      await submit(
        api,
        wagerBody({
          walletId: wallet.id,
          playerId: wallet.playerId,
          kind: "REFUND",
          amount: "10.00",
          externalTransactionId: refundId,
          referenceExternalTransactionId: betId,
        }),
      );
      await submit(
        api,
        wagerBody({
          walletId: wallet.id,
          playerId: wallet.playerId,
          kind: "BET",
          amount: "10.00",
          externalTransactionId: betId,
        }),
      );
      await makeDue(refundId);
    }

    const reports = await Promise.all(
      [first, second].map((app) => app.get(ResolvePendingReferencesUseCase).resolveDue(20)),
    );

    expect(reports.reduce((total, report) => total + report.resolved, 0)).toBe(10);
    for (const refundId of refunds) expect((await transactionRow(refundId)).status).toBe("PROCESSED");
    const [balance] = await sql<{ balance: string }>("select balance from wallets where id = ?", [wallet.id]);
    expect(balance!.balance).toBe("1000.00");
    await expectLedgerMatchesBalances(api.orm);
  });
});

describe("workers role", () => {
  test("publishes events and resolves pending references on its own", async () => {
    const workers: INestApplicationContext = await startConsumer({ APP_ROLE: "workers" });
    try {
      const wallet = await createWallet(api, "100.00");
      const betId = id();
      const refundId = id();
      await submit(
        api,
        wagerBody({
          walletId: wallet.id,
          playerId: wallet.playerId,
          kind: "REFUND",
          amount: "15.00",
          externalTransactionId: refundId,
          referenceExternalTransactionId: betId,
        }),
      );
      await submit(
        api,
        wagerBody({
          walletId: wallet.id,
          playerId: wallet.playerId,
          kind: "BET",
          amount: "15.00",
          externalTransactionId: betId,
        }),
      );
      await makeDue(refundId);

      await eventually(
        async () => (await transactionRow(refundId)).status,
        (status) => status === "PROCESSED",
      );
      await eventually(unpublished, (total) => total === 0);
    } finally {
      await workers.close();
    }
  }, 30_000);
});
