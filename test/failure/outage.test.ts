import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { loadEnv } from "../../src/core/config/env";
import {
  createWallet,
  expectLedgerMatchesBalances,
  startTestApi,
  submit,
  type TestApi,
  wagerBody,
} from "../support/api";
import { id } from "../support/database";
import { count, type RoleProcess, spawnRole } from "../support/processes";
import { drain, envelope, eventually, pendingCount, purge, sendRaw, testSqs, wagerData } from "../support/queue";
import { freePort, startSqsProxy } from "../support/sqs-proxy";

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
const unpublished = () => total("select count(*)::int as total from outbox_messages where published_at is null");
const settledFor = (walletId: string) =>
  total("select count(*)::int as total from wager_transactions where wallet_id = ? and kind <> 'OPENING'", [walletId]);

beforeAll(async () => {
  await setupQueues();
  api = await startTestApi();
  sqs = testSqs();
});

beforeEach(async () => {
  await purge(sqs, QUEUE, DLQ, EVENTS);
  await sql("update outbox_messages set published_at = now() where published_at is null");
});

afterAll(async () => {
  await Promise.all(running.map((child) => child.kill().catch(() => undefined)));
  sqs?.destroy();
  await api?.close();
});

describe("temporary unavailability of dependencies", () => {
  test("an SQS outage pauses consumption and publication, readiness reports it, and everything resumes without loss", async () => {
    const proxy = startSqsProxy(env.sqs.endpoint);
    const port = await freePort();
    const viaProxy = { SQS_ENDPOINT: proxy.endpoint };
    const wallet = await createWallet(api, "100.00");
    const processes = [
      start("api", { ...viaProxy, PORT: String(port) }),
      start("consumer", viaProxy),
      start("workers", viaProxy),
    ];

    try {
      await Promise.all(
        processes.map((child) => child.waitFor(child.role === "api" ? "api ready" : "started", 20_000)),
      );
      proxy.outage(true);
      await processes[1]!.waitFor("receive failed, pausing", 15_000);

      for (let index = 0; index < 10; index += 1) {
        await sendRaw(
          sqs,
          QUEUE,
          envelope(wagerData(wallet, { money: { amount: "2.00", currency: "BRL" } })),
          wallet.id,
        );
      }
      const submissions = await Promise.all(
        Array.from({ length: 5 }, () =>
          submit(api, wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "1.00" })),
        ),
      );
      expect(submissions.every((submission) => submission.status === 200)).toBe(true);
      const ready = await fetch(`http://localhost:${port}/health/ready`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toMatchObject({ checks: { sqs: "down", postgres: "up" } });

      await Bun.sleep(3_000);
      expect(await settledFor(wallet.id)).toBe(5);
      expect(await unpublished()).toBeGreaterThan(0);
      expect(count(processes[1]!.output(), "receive failed, pausing")).toBeGreaterThan(0);

      proxy.outage(false);
      await eventually(
        () => settledFor(wallet.id),
        (settled) => settled === 15,
        30_000,
      );
      await eventually(
        () => pendingCount(sqs, QUEUE),
        (pending) => pending === 0,
        30_000,
      );
      await eventually(unpublished, (left) => left === 0, 30_000);
      expect((await fetch(`http://localhost:${port}/health/ready`)).status).toBe(200);
    } finally {
      proxy.stop();
      await Promise.all(processes.map((child) => child.kill("SIGTERM")));
    }

    const [row] = await sql<{ balance: string }>("select balance from wallets where id = ?", [wallet.id]);
    expect(row!.balance).toBe("75.00");
    const eventIds = (await drain(sqs, EVENTS)).map(
      (message) => (JSON.parse(message.Body ?? "{}") as { eventId: string }).eventId,
    );
    expect(new Set(eventIds).size).toBe(eventIds.length);
    expect(await drain(sqs, DLQ)).toEqual([]);
    await expectLedgerMatchesBalances(api.orm);
  }, 120_000);

  test("database connections dropped repeatedly while messages are settled are retried, and each message settles once", async () => {
    const applicationName = `outage-${id().slice(-8)}`;
    const wallets = await Promise.all(Array.from({ length: 4 }, () => createWallet(api, "100.00")));
    for (const wallet of wallets) {
      for (let index = 0; index < 10; index += 1) {
        await sendRaw(
          sqs,
          QUEUE,
          envelope(wagerData(wallet, { money: { amount: "4.00", currency: "BRL" } })),
          wallet.id,
        );
      }
    }

    const consumer = start("consumer", { PGAPPNAME: applicationName });
    let terminated = 0;
    try {
      await consumer.waitFor("consumer started", 20_000);
      const until = Date.now() + 3_000;
      while (Date.now() < until) {
        const killed = await sql<{ pid: number }>(
          "with targets as materialized (select pid from pg_stat_activity where application_name = ?) select pid from targets where pg_terminate_backend(pid)",
          [applicationName],
        );
        terminated += killed.length;
        await Bun.sleep(100);
      }

      await eventually(
        async () => (await Promise.all(wallets.map((wallet) => settledFor(wallet.id)))).reduce((sum, n) => sum + n, 0),
        (settled) => settled === 40,
        60_000,
      );
      await eventually(
        () => pendingCount(sqs, QUEUE),
        (pending) => pending === 0,
        60_000,
      );
    } finally {
      await consumer.kill("SIGTERM");
    }

    expect(terminated).toBeGreaterThan(0);
    expect(count(consumer.output(), "transient message failure")).toBeGreaterThan(0);
    for (const wallet of wallets) {
      const [row] = await sql<{ balance: string }>("select balance from wallets where id = ?", [wallet.id]);
      expect(row!.balance).toBe("60.00");
    }
    expect(await drain(sqs, DLQ)).toEqual([]);
    await expectLedgerMatchesBalances(api.orm);
  }, 120_000);
});
