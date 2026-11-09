import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { INestApplicationContext } from "@nestjs/common";
import type { Registry } from "prom-client";
import { METRICS_REGISTRY } from "../../../src/core/observability/metrics";
import { EVENT_PUBLISHER, type EventPublisher } from "../../../src/wagering/application/ports/event-publisher.port";
import { PublishOutboxUseCase } from "../../../src/wagering/application/use-cases/publish-outbox.use-case";
import { ResolvePendingReferencesUseCase } from "../../../src/wagering/application/use-cases/resolve-pending-references.use-case";
import { createWallet, startTestApi, submit, type TestApi, wagerBody } from "../../support/api";
import { id } from "../../support/database";
import { spawnRole } from "../../support/processes";
import {
  envelope,
  eventually,
  pendingCount,
  purge,
  sendRaw,
  startConsumer,
  testEnv,
  testSqs,
  wagerData,
} from "../../support/queue";
import { freePort } from "../../support/sqs-proxy";

const env = testEnv();

let api: TestApi;
let sqs: SQSClient;

async function setupQueues(): Promise<void> {
  const child = Bun.spawn(["bun", "scripts/setup-queues.ts"], { stdout: "ignore", stderr: "inherit" });
  expect(await child.exited).toBe(0);
}

function metricValue(text: string, name: string, labels: Record<string, string> = {}): number {
  return text
    .split("\n")
    .filter((line) => line.startsWith(`${name}{`) || line.startsWith(`${name} `))
    .filter((line) => Object.entries(labels).every(([key, value]) => line.includes(`${key}="${value}"`)))
    .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(" ") + 1)), 0);
}

const scrape = async () => {
  const response = await fetch(`${api.url}/metrics`);
  return response.text();
};
const registryOf = (app: INestApplicationContext) => app.get<Registry>(METRICS_REGISTRY).metrics();

const sql = <T>(query: string, params: unknown[] = []) => api.orm.em.getConnection().execute<T[]>(query, params);

beforeAll(async () => {
  await setupQueues();
  api = await startTestApi();
  sqs = testSqs();
  await purge(sqs, env.sqs.wagerQueue, env.sqs.wagerDlq, env.sqs.eventsQueue);
});

afterAll(async () => {
  sqs?.destroy();
  await api?.close();
});

describe("metrics", () => {
  test("the API counts transactions by status, duplicates, lock conflicts and latency", async () => {
    const before = await scrape();
    const wallet = await createWallet(api, "50.00");
    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "30.00" });

    await submit(api, body);
    await submit(api, body);
    await submit(api, { ...body, money: { amount: "31.00", currency: "BRL" } });
    await submit(api, wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "99.00" }));
    await api.orm.em.fork().transactional(async (em) => {
      await em
        .getConnection()
        .execute("select id from wallets where id = ? for update", [wallet.id], "all", em.getTransactionContext());
      const blocked = await submit(
        api,
        wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "1.00" }),
      );
      expect(blocked.status).toBe(503);
    });

    const after = await scrape();
    const delta = (name: string, labels: Record<string, string> = {}) =>
      metricValue(after, name, labels) - metricValue(before, name, labels);

    expect(delta("wagering_transactions_total", { status: "PROCESSED", source: "http" })).toBe(1);
    expect(delta("wagering_transactions_total", { status: "REJECTED", source: "http" })).toBe(1);
    expect(delta("wagering_duplicates_total", { kind: "idempotent-replay" })).toBe(1);
    expect(delta("wagering_duplicates_total", { kind: "idempotency-conflict" })).toBe(1);
    expect(delta("wagering_lock_conflicts_total")).toBe(1);
    expect(delta("wagering_processing_duration_seconds_count", { source: "http" })).toBe(5);
    expect(after).not.toContain("wagering_outbox_pending");
    expect(after).not.toContain("wagering_outbox_lag_seconds");
  }, 20_000);

  test("the consumer counts queue settlements, duplicate messages, retries and dead letters", async () => {
    const consumer = await startConsumer();
    try {
      const before = await registryOf(consumer);
      const wallet = await createWallet(api, "100.00");
      const settled = envelope(wagerData(wallet));
      await sendRaw(sqs, env.sqs.wagerQueue, settled, wallet.id);
      await sendRaw(sqs, env.sqs.wagerQueue, settled, wallet.id);
      await sendRaw(sqs, env.sqs.wagerQueue, "not json");
      await api.orm.em.fork().transactional(async (em) => {
        await em
          .getConnection()
          .execute("select id from wallets where id = ? for update", [wallet.id], "all", em.getTransactionContext());
        await sendRaw(sqs, env.sqs.wagerQueue, envelope(wagerData(wallet)), wallet.id);
        await eventually(
          async () => metricValue(await registryOf(consumer), "wagering_retries_total", { operation: "message" }),
          (retries) => retries > metricValue(before, "wagering_retries_total", { operation: "message" }),
        );
      });
      await eventually(
        () => pendingCount(sqs, env.sqs.wagerQueue),
        (pending) => pending === 0,
        20_000,
      );

      const after = await registryOf(consumer);
      const delta = (name: string, labels: Record<string, string> = {}) =>
        metricValue(after, name, labels) - metricValue(before, name, labels);
      expect(delta("wagering_transactions_total", { status: "PROCESSED", source: "queue" })).toBe(2);
      expect(delta("wagering_duplicates_total", { kind: "duplicate-message" })).toBe(1);
      expect(delta("wagering_dead_letters_total", { reason: "INVALID_MESSAGE" })).toBe(1);
      expect(metricValue(after, "wagering_dead_letter_queue_messages")).toBeGreaterThanOrEqual(1);
      expect(delta("wagering_retries_total", { operation: "message" })).toBeGreaterThanOrEqual(1);
      expect(delta("wagering_lock_conflicts_total")).toBeGreaterThanOrEqual(1);
      expect(delta("wagering_processing_duration_seconds_count", { source: "queue" })).toBeGreaterThanOrEqual(3);
    } finally {
      await consumer.close();
    }
  }, 40_000);

  test("the workers report outbox backlog, publication retries and pending-reference outcomes", async () => {
    const workers = await startConsumer({ APP_ROLE: "api" });
    try {
      await sql("update outbox_messages set published_at = now() where published_at is null");
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
      const missingId = id();
      await submit(
        api,
        wagerBody({
          walletId: wallet.id,
          playerId: wallet.playerId,
          kind: "REFUND",
          amount: "10.00",
          externalTransactionId: missingId,
          referenceExternalTransactionId: id(),
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
      await sql(
        "update wager_transactions set next_reference_attempt_at = now() - interval '1 second' where external_transaction_id in (?)",
        [[refundId, missingId]],
      );
      const before = await registryOf(workers);

      await workers.get(ResolvePendingReferencesUseCase).resolveDue(20);
      const publisher = workers.get<EventPublisher>(EVENT_PUBLISHER);
      publisher.publish = async () => new Set<string>();
      try {
        await workers.get(PublishOutboxUseCase).publishDue(50);
      } finally {
        delete (publisher as { publish?: unknown }).publish;
      }

      const after = await registryOf(workers);
      const delta = (name: string, labels: Record<string, string> = {}) =>
        metricValue(after, name, labels) - metricValue(before, name, labels);
      expect(delta("wagering_transactions_total", { status: "PROCESSED", source: "worker" })).toBe(1);
      expect(delta("wagering_retries_total", { operation: "pending-reference" })).toBe(1);
      expect(delta("wagering_retries_total", { operation: "publication" })).toBeGreaterThanOrEqual(1);
      expect(metricValue(after, "wagering_outbox_pending")).toBeGreaterThanOrEqual(1);
      expect(metricValue(after, "wagering_outbox_lag_seconds")).toBeGreaterThanOrEqual(0);

      await sql("update outbox_messages set next_attempt_at = now()");
      while ((await workers.get(PublishOutboxUseCase).publishDue(50)).claimed > 0);
      expect(metricValue(await registryOf(workers), "wagering_outbox_pending")).toBe(0);
      expect(metricValue(await registryOf(workers), "wagering_outbox_lag_seconds")).toBe(0);
    } finally {
      await workers.close();
    }
  }, 30_000);

  test("background roles expose their metrics over HTTP when METRICS_PORT is set", async () => {
    const port = await freePort();
    const consumer = spawnRole("consumer", { METRICS_PORT: String(port) });
    try {
      await consumer.waitFor("metrics server ready");
      const metrics = await (await fetch(`http://localhost:${port}/metrics`)).text();
      const live = await fetch(`http://localhost:${port}/health/live`);

      expect(metrics).toContain('role="consumer"');
      expect(metrics).toContain("wagering_transactions_total");
      expect(live.status).toBe(200);
    } finally {
      await consumer.kill("SIGTERM");
    }
  }, 20_000);
});
