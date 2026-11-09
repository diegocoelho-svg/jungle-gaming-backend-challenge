import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { loadEnv } from "../../src/core/config/env";
import {
  call,
  createWallet,
  expectLedgerMatchesBalances,
  startTestApi,
  submit,
  type TestApi,
  wagerBody,
} from "../support/api";
import { id } from "../support/database";
import { count, type RoleProcess, spawnRole } from "../support/processes";
import { freePort, startSqsProxy } from "../support/sqs-proxy";
import { drain, envelope, eventually, pendingCount, purge, sendRaw, testSqs, wagerData } from "../support/queue";

const env = loadEnv();
const QUEUE = env.sqs.wagerQueue;
const DLQ = env.sqs.wagerDlq;
const EVENTS = env.sqs.eventsQueue;

let api: TestApi;
let sqs: SQSClient;
const running: RoleProcess[] = [];

const start = (role: "api" | "consumer" | "workers", overrides: Record<string, string> = {}) => {
  const child = spawnRole(role, overrides);
  running.push(child);
  return child;
};

async function setupQueues(): Promise<void> {
  const child = Bun.spawn(["bun", "scripts/setup-queues.ts"], { stdout: "ignore", stderr: "inherit" });
  expect(await child.exited).toBe(0);
}

const sql = <T>(query: string, params: unknown[] = []) => api.orm.em.getConnection().execute<T[]>(query, params);

const total = async (query: string, params: unknown[] = []) => (await sql<{ total: number }>(query, params))[0]!.total;

const settledFor = (walletId: string) =>
  total("select count(*)::int as total from wager_transactions where wallet_id = ? and kind <> 'OPENING'", [walletId]);

const balanceOf = async (walletId: string) =>
  (await sql<{ balance: string }>("select balance from wallets where id = ?", [walletId]))[0]!.balance;

const unpublished = () => total("select count(*)::int as total from outbox_messages where published_at is null");

const inboxRows = (messageIds: string[]) =>
  messageIds.length === 0
    ? Promise.resolve(0)
    : total("select count(*)::int as total from inbox_messages where message_id in (?)", [messageIds]);

async function within<T>(promise: Promise<T>, timeoutMs: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(reason)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function expectConsistentWallets(walletIds: string[]): Promise<void> {
  await expectLedgerMatchesBalances(api.orm);
  for (const walletId of walletIds) {
    const report = await call<{ consistent: boolean }>(api, "POST", `/wallets/${walletId}/reconciliation`);
    expect(report.body.consistent).toBe(true);
  }
}

beforeAll(async () => {
  await setupQueues();
  api = await startTestApi();
  sqs = testSqs();
});

beforeEach(async () => {
  await purge(sqs, QUEUE, DLQ, EVENTS);
});

afterAll(async () => {
  await Promise.all(running.map((child) => child.kill().catch(() => undefined)));
  sqs?.destroy();
  await api?.close();
});

describe("failure and recovery with real processes", () => {
  test("three consumer processes share a hot backlog with duplicates and settle every operation once", async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => createWallet(api, "100.00")));
    const bodies = wallets.flatMap((wallet) =>
      Array.from({ length: 30 }, () => envelope(wagerData(wallet, { money: { amount: "1.00", currency: "BRL" } }))),
    );
    for (const [index, body] of bodies.entries()) {
      const walletId = wallets[Math.floor(index / 30)]!.id;
      await sendRaw(sqs, QUEUE, body, walletId);
      if (index % 3 === 0) await sendRaw(sqs, QUEUE, body, walletId);
    }

    const consumers = [start("consumer"), start("consumer"), start("consumer")];
    await Promise.all(consumers.map((consumer) => consumer.waitFor("consumer started")));

    await eventually(
      () => pendingCount(sqs, QUEUE),
      (pending) => pending === 0,
      60_000,
    );
    await Promise.all(consumers.map((consumer) => consumer.kill("SIGTERM")));

    const settledBy = consumers.map((consumer) => count(consumer.output(), '"msg":"message settled"'));
    expect(settledBy.filter((settled) => settled > 0).length).toBeGreaterThanOrEqual(2);
    expect(settledBy.reduce((sum, settled) => sum + settled, 0)).toBe(150);
    for (const wallet of wallets) {
      expect(await settledFor(wallet.id)).toBe(30);
      expect(await balanceOf(wallet.id)).toBe("70.00");
    }
    expect(await drain(sqs, DLQ)).toEqual([]);
    await expectConsistentWallets(wallets.map((wallet) => wallet.id));
  }, 90_000);

  test("a consumer killed between commit and ack causes no second debit after redelivery", async () => {
    const proxy = startSqsProxy(env.sqs.endpoint);
    const wallet = await createWallet(api, "100.00");
    const messageId = id();

    let victim: RoleProcess | undefined;
    try {
      const ackReached = proxy.hold("DeleteMessage");
      victim = start("consumer", { SQS_ENDPOINT: proxy.endpoint });
      await sendRaw(
        sqs,
        QUEUE,
        envelope(wagerData(wallet, { money: { amount: "40.00", currency: "BRL" } }), messageId),
        wallet.id,
      );
      await within(ackReached, 20_000, "the consumer never tried to acknowledge");

      expect(await balanceOf(wallet.id)).toBe("60.00");
      expect(await inboxRows([messageId])).toBe(1);
    } finally {
      await victim?.kill("SIGKILL");
      proxy.stop();
    }

    const survivor = start("consumer");
    await survivor.waitFor('"msg":"duplicate message acknowledged"', 45_000);
    await eventually(
      () => pendingCount(sqs, QUEUE),
      (pending) => pending === 0,
    );
    await survivor.kill("SIGTERM");

    expect(count(survivor.output(), '"msg":"message settled"')).toBe(0);
    expect(await balanceOf(wallet.id)).toBe("60.00");
    expect(await settledFor(wallet.id)).toBe(1);
  }, 90_000);

  test("a consumer killed with SIGKILL in the middle of a batch loses and duplicates nothing after restart", async () => {
    const proxy = startSqsProxy(env.sqs.endpoint);
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet(api, "100.00")));
    const messageIds: string[] = [];
    for (const wallet of wallets) {
      for (let index = 0; index < 8; index += 1) {
        const messageId = id();
        messageIds.push(messageId);
        await sendRaw(
          sqs,
          QUEUE,
          envelope(wagerData(wallet, { money: { amount: "5.00", currency: "BRL" } }), messageId),
          wallet.id,
        );
      }
    }
    const settledAll = async () =>
      (await Promise.all(wallets.map((wallet) => settledFor(wallet.id)))).reduce((sum, settled) => sum + settled, 0);

    let settledAtKill = 0;
    let victim: RoleProcess | undefined;
    try {
      const ackReached = proxy.hold("DeleteMessage");
      victim = start("consumer", { SQS_ENDPOINT: proxy.endpoint });
      await within(ackReached, 20_000, "the consumer never tried to acknowledge");
      settledAtKill = await settledAll();
    } finally {
      await victim?.kill("SIGKILL");
      proxy.stop();
    }

    const survivor = start("consumer");
    await eventually(settledAll, (settled) => settled === 80, 60_000);
    await eventually(
      () => pendingCount(sqs, QUEUE),
      (pending) => pending === 0,
      60_000,
    );
    await survivor.kill("SIGTERM");

    expect(settledAtKill).toBeGreaterThan(0);
    expect(settledAtKill).toBeLessThan(80);
    expect(count(survivor.output(), '"msg":"duplicate message acknowledged"')).toBeGreaterThanOrEqual(1);
    for (const wallet of wallets) {
      expect(await settledFor(wallet.id)).toBe(8);
      expect(await balanceOf(wallet.id)).toBe("60.00");
    }
    expect(await inboxRows(messageIds)).toBe(80);
    expect(await drain(sqs, DLQ)).toEqual([]);
    await expectConsistentWallets(wallets.map((wallet) => wallet.id));
  }, 120_000);

  test("a publisher killed after sending and before marking leaves nothing lost, and the resend is deduplicated", async () => {
    await sql("update outbox_messages set published_at = now() where published_at is null");
    const wallet = await createWallet(api, "10000.00");
    const submissions = await Promise.all(
      Array.from({ length: 150 }, () =>
        submit(api, wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "1.00" })),
      ),
    );
    expect(submissions.every((submission) => submission.status === 200)).toBe(true);
    const expected = await unpublished();
    const proxy = startSqsProxy(env.sqs.endpoint);

    let victim: RoleProcess | undefined;
    try {
      const sent = proxy.hold("SendMessageBatch", { forwardFirst: true });
      victim = start("workers", { SQS_ENDPOINT: proxy.endpoint });
      await within(sent, 20_000, "the publisher never sent a batch");
      expect(await unpublished()).toBe(expected);
    } finally {
      await victim?.kill("SIGKILL");
      proxy.stop();
    }

    const survivor = start("workers");
    await eventually(unpublished, (left) => left === 0, 30_000);
    await survivor.kill("SIGTERM");

    const received = await drain(sqs, EVENTS);
    const eventIds = received.map((message) => (JSON.parse(message.Body ?? "{}") as { eventId: string }).eventId);
    expect(expected).toBe(302);
    expect(eventIds).toHaveLength(expected);
    expect(new Set(eventIds).size).toBe(expected);
  }, 90_000);

  test("killing every process under load and restarting ends with consistent balances and nothing pending", async () => {
    const port = String(await freePort());
    const roles = () => [start("api", { PORT: port }), start("consumer"), start("consumer"), start("workers")];
    const ready = (processes: RoleProcess[]) =>
      Promise.all(processes.map((child) => child.waitFor(child.role === "api" ? "api ready" : "started", 20_000)));

    const wallets = await Promise.all(Array.from({ length: 6 }, () => createWallet(api, "500.00")));
    const refunds: string[] = [];
    const queued: string[] = [];
    for (const wallet of wallets) {
      for (let index = 0; index < 25; index += 1) {
        const messageId = id();
        queued.push(messageId);
        await sendRaw(
          sqs,
          QUEUE,
          envelope(wagerData(wallet, { money: { amount: "3.00", currency: "BRL" } }), messageId),
          wallet.id,
        );
      }
      const betId = id();
      const refundId = id();
      refunds.push(refundId);
      await sendRaw(
        sqs,
        QUEUE,
        envelope(
          wagerData(wallet, {
            kind: "REFUND",
            externalTransactionId: refundId,
            idempotencyKey: `provider-a:${refundId}`,
            referenceExternalTransactionId: betId,
            money: { amount: "3.00", currency: "BRL" },
          }),
        ),
        wallet.id,
      );
      await sendRaw(
        sqs,
        QUEUE,
        envelope(
          wagerData(wallet, {
            externalTransactionId: betId,
            idempotencyKey: `provider-a:${betId}`,
            money: { amount: "3.00", currency: "BRL" },
          }),
        ),
        wallet.id,
      );
    }

    let processes = roles();
    await ready(processes);
    const baseUrl = `http://localhost:${port}`;
    let httpAccepted = 0;
    const httpLoad = wallets.flatMap((wallet) =>
      Array.from({ length: 15 }, async () => {
        const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "2.00" });
        const response = await fetch(`${baseUrl}/wagering/transactions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `${body.providerId}:${body.externalTransactionId}`,
          },
          body: JSON.stringify(body),
        }).catch(() => undefined);
        if (response?.status === 200) httpAccepted += 1;
        return { walletId: wallet.id, accepted: response?.status === 200 };
      }),
    );

    await eventually(
      async () => (await inboxRows(queued)) > 0 && httpAccepted > 0,
      (progressed) => progressed,
      20_000,
    );
    await Promise.all(processes.map((child) => child.kill("SIGKILL")));
    const settledAtKill = await inboxRows(queued);
    const accepted = await Promise.all(httpLoad);
    await sql(
      "update wager_transactions set next_reference_attempt_at = now() where status = 'PENDING_REFERENCE' and external_transaction_id in (?)",
      [refunds],
    );

    processes = roles();
    await ready(processes);
    await eventually(
      () => inboxRows(queued),
      (settled) => settled === queued.length,
      90_000,
    );
    await eventually(
      () => pendingCount(sqs, QUEUE),
      (pending) => pending === 0,
      60_000,
    );
    await eventually(
      () => total("select count(*)::int as total from wager_transactions where status = 'PENDING_REFERENCE'"),
      (pending) => pending === 0,
      30_000,
    );
    await eventually(unpublished, (left) => left === 0, 30_000);
    await Promise.all(processes.map((child) => child.kill("SIGTERM")));

    expect(settledAtKill).toBeLessThan(queued.length);
    for (const refundId of refunds) {
      const [row] = await sql<{ status: string }>(
        "select status from wager_transactions where external_transaction_id = ?",
        [refundId],
      );
      expect(row?.status).toBe("PROCESSED");
    }
    for (const wallet of wallets) {
      expect(
        await total(
          "select count(*)::int as total from wager_transactions where wallet_id = ? and amount = 3.00 and kind = 'BET'",
          [wallet.id],
        ),
      ).toBe(26);
      const acceptedHttp = accepted.filter((result) => result.walletId === wallet.id && result.accepted).length;
      const storedHttp = await total(
        "select count(*)::int as total from wager_transactions where wallet_id = ? and amount = 2.00 and kind = 'BET'",
        [wallet.id],
      );
      expect(storedHttp).toBeGreaterThanOrEqual(acceptedHttp);
      expect(storedHttp).toBeLessThanOrEqual(15);
    }
    expect(await drain(sqs, DLQ)).toEqual([]);
    await expectConsistentWallets(wallets.map((wallet) => wallet.id));
  }, 240_000);
});
