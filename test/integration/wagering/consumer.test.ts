import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { INestApplicationContext } from "@nestjs/common";
import {
  createWallet,
  expectLedgerMatchesBalances,
  startTestApi,
  submit,
  type TestApi,
  wagerBody,
} from "../../support/api";
import { TransientFailureError } from "../../../src/wagering/application/errors/application.error";
import { ProcessWagerTransactionUseCase } from "../../../src/wagering/application/use-cases/process-wager-transaction.use-case";
import { id } from "../../support/database";
import {
  createRetryQueues,
  drain,
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

const env = testEnv();
const QUEUE = env.sqs.wagerQueue;
const DLQ = env.sqs.wagerDlq;

let api: TestApi;
let sqs: SQSClient;
let consumer: INestApplicationContext;

async function setupQueues(): Promise<void> {
  const child = Bun.spawn(["bun", "scripts/setup-queues.ts"], { stdout: "ignore", stderr: "inherit" });
  expect(await child.exited).toBe(0);
}

const sql = async <T>(query: string, params: unknown[] = []) => api.orm.em.getConnection().execute<T[]>(query, params);

const transactionsOf = async (walletId: string) =>
  (
    await sql<{ total: number }>(
      "select count(*)::int as total from wager_transactions where wallet_id = ? and kind <> 'OPENING'",
      [walletId],
    )
  )[0]!.total;

const balanceOf = async (walletId: string) =>
  (await sql<{ balance: string }>("select balance from wallets where id = ?", [walletId]))[0]!.balance;

const inboxHas = async (messageId: string) =>
  (
    await sql<{ total: number }>("select count(*)::int as total from inbox_messages where message_id = ?", [messageId])
  )[0]!.total;

const deadLetterReasons = async () =>
  (await drain(sqs, DLQ)).map((message) => message.MessageAttributes?.reason?.StringValue);

async function collectDeadLetters(expected: number): Promise<(string | undefined)[]> {
  const collected: (string | undefined)[] = [];
  return eventually(
    async () => {
      collected.push(...(await deadLetterReasons()));
      return collected;
    },
    (found) => found.length >= expected,
  );
}

const lockWallet = (walletId: string, work: () => Promise<void>) =>
  api.orm.em.fork().transactional(async (em) => {
    await em
      .getConnection()
      .execute("select id from wallets where id = ? for update", [walletId], "all", em.getTransactionContext());
    await work();
  });

function recordSettlementFailures(app: INestApplicationContext = consumer) {
  const useCase = app.get(ProcessWagerTransactionUseCase);
  const original = useCase.executeFromMessage.bind(useCase);
  const failures: unknown[] = [];
  useCase.executeFromMessage = async (...args) => {
    try {
      return await original(...args);
    } catch (error) {
      failures.push(error);
      throw error;
    }
  };
  return {
    failures,
    restore: () => {
      delete (useCase as { executeFromMessage?: unknown }).executeFromMessage;
    },
  };
}

const waitingOnLocks = async () =>
  (
    await sql<{ total: number }>(
      "select count(*)::int as total from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()",
    )
  )[0]!.total;

beforeAll(async () => {
  await setupQueues();
  api = await startTestApi();
  sqs = testSqs();
  await purge(sqs, QUEUE, DLQ);
  consumer = await startConsumer();
});

afterAll(async () => {
  await consumer?.close();
  sqs?.destroy();
  await api?.close();
});

beforeEach(async () => {
  await eventually(
    () => pendingCount(sqs, QUEUE),
    (count) => count === 0,
  );
  await drain(sqs, DLQ, 0);
});

describe("wager transactions consumer", () => {
  test("settles a message through the same use case and acknowledges it after commit", async () => {
    const wallet = await createWallet(api, "100.00");
    const messageId = id();

    await sendRaw(
      sqs,
      QUEUE,
      envelope(wagerData(wallet, { money: { amount: "25.00", currency: "BRL" } }), messageId),
      wallet.id,
    );

    await eventually(
      () => balanceOf(wallet.id),
      (balance) => balance === "75.00",
    );
    await eventually(
      () => pendingCount(sqs, QUEUE),
      (count) => count === 0,
    );
    expect(await inboxHas(messageId)).toBe(1);
  });

  test("a failed commit leaves the message unacknowledged, and it settles once when redelivered", async () => {
    const wallet = await createWallet(api, "100.00");
    const messageId = id();

    const recorder = recordSettlementFailures();
    await sql("alter table outbox_messages rename to outbox_messages_unavailable");
    try {
      await sendRaw(sqs, QUEUE, envelope(wagerData(wallet), messageId), wallet.id);
      await eventually(
        async () => recorder.failures.length,
        (total) => total > 0,
      );

      expect(await pendingCount(sqs, QUEUE)).toBe(1);
      expect(await inboxHas(messageId)).toBe(0);
      expect(await transactionsOf(wallet.id)).toBe(0);
    } finally {
      await sql("alter table outbox_messages_unavailable rename to outbox_messages");
      recorder.restore();
    }

    await eventually(
      () => balanceOf(wallet.id),
      (balance) => balance === "90.00",
      20_000,
    );
    await eventually(
      () => pendingCount(sqs, QUEUE),
      (count) => count === 0,
    );
    expect(await transactionsOf(wallet.id)).toBe(1);
    expect(await inboxHas(messageId)).toBe(1);
  }, 30_000);

  test("a redelivered message does not settle twice", async () => {
    const wallet = await createWallet(api, "100.00");
    const messageId = id();
    const body = envelope(wagerData(wallet), messageId);

    await sendRaw(sqs, QUEUE, body, wallet.id);
    await sendRaw(sqs, QUEUE, body, wallet.id);
    await sendRaw(sqs, QUEUE, body, wallet.id);

    await eventually(
      () => pendingCount(sqs, QUEUE),
      (count) => count === 0,
    );
    expect(await balanceOf(wallet.id)).toBe("90.00");
    expect(await transactionsOf(wallet.id)).toBe(1);
    expect(await deadLetterReasons()).toEqual([]);
  });

  test("the same transaction submitted over HTTP and through the queue has a single effect", async () => {
    const wallet = await createWallet(api, "100.00");
    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "10.00" });

    const http = await submit(api, body);
    await sendRaw(
      sqs,
      QUEUE,
      envelope({ ...body, idempotencyKey: `${body.providerId}:${body.externalTransactionId}` }),
      wallet.id,
    );

    await eventually(
      () => pendingCount(sqs, QUEUE),
      (count) => count === 0,
    );
    expect(http.status).toBe(200);
    expect(await balanceOf(wallet.id)).toBe("90.00");
    expect(await transactionsOf(wallet.id)).toBe(1);
  });

  test("an idempotency conflict is acknowledged without changing the balance", async () => {
    const wallet = await createWallet(api, "100.00");
    const data = wagerData(wallet);

    await sendRaw(sqs, QUEUE, envelope(data), wallet.id);
    await sendRaw(sqs, QUEUE, envelope({ ...data, money: { amount: "50.00", currency: "BRL" } }), wallet.id);

    await eventually(
      () => pendingCount(sqs, QUEUE),
      (count) => count === 0,
    );
    expect(await balanceOf(wallet.id)).toBe("90.00");
    expect(await deadLetterReasons()).toEqual([]);
  });

  test("business rejections are terminal and acknowledged", async () => {
    const wallet = await createWallet(api, "5.00");

    await sendRaw(sqs, QUEUE, envelope(wagerData(wallet, { money: { amount: "50.00", currency: "BRL" } })), wallet.id);

    await eventually(
      () => transactionsOf(wallet.id),
      (total) => total === 1,
    );
    await eventually(
      () => pendingCount(sqs, QUEUE),
      (count) => count === 0,
    );
    const [row] = await sql<{ status: string; failure_code: string }>(
      "select status, failure_code from wager_transactions where wallet_id = ? and kind = 'BET'",
      [wallet.id],
    );
    expect(row).toEqual({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" });
    expect(await balanceOf(wallet.id)).toBe("5.00");
  });

  test("permanent failures go straight to the dead-letter queue", async () => {
    const wallet = await createWallet(api, "100.00");

    await sendRaw(sqs, QUEUE, "not json");
    await sendRaw(sqs, QUEUE, envelope(wagerData(wallet, { kind: "OPENING" })), wallet.id);
    await sendRaw(sqs, QUEUE, envelope(wagerData(wallet, { money: { amount: "10.5", currency: "BRL" } })), wallet.id);
    await sendRaw(sqs, QUEUE, envelope(wagerData({ id: id(), playerId: wallet.playerId })), "unknown-wallet");

    await eventually(
      () => pendingCount(sqs, QUEUE),
      (count) => count === 0,
    );
    const reasons = await collectDeadLetters(4);
    expect(reasons.sort()).toEqual(["INVALID_MESSAGE", "INVALID_MESSAGE", "INVALID_MESSAGE", "WALLET_NOT_FOUND"]);
    expect(await transactionsOf(wallet.id)).toBe(0);
  });

  test("a message id reused with different content is dead-lettered", async () => {
    const wallet = await createWallet(api, "100.00");
    const messageId = id();

    await sendRaw(sqs, QUEUE, envelope(wagerData(wallet), messageId), wallet.id);
    await eventually(
      () => inboxHas(messageId),
      (total) => total === 1,
    );
    await sendRaw(sqs, QUEUE, envelope(wagerData(wallet), messageId), wallet.id);

    const reasons = await collectDeadLetters(1);
    expect(reasons).toEqual(["MESSAGE_ID_REUSED"]);
    expect(await transactionsOf(wallet.id)).toBe(1);
  });

  test("a transient failure is retried after a backoff instead of being acknowledged", async () => {
    const wallet = await createWallet(api, "100.00");

    const recorder = recordSettlementFailures();
    try {
      await lockWallet(wallet.id, async () => {
        await sendRaw(sqs, QUEUE, envelope(wagerData(wallet)), wallet.id);
        await eventually(
          async () => recorder.failures.length,
          (total) => total > 0,
        );

        expect(recorder.failures[0]).toBeInstanceOf(TransientFailureError);
        expect(await pendingCount(sqs, QUEUE)).toBe(1);
        expect(await transactionsOf(wallet.id)).toBe(0);
      });
    } finally {
      recorder.restore();
    }

    await eventually(
      () => balanceOf(wallet.id),
      (balance) => balance === "90.00",
      20_000,
    );
    await eventually(
      () => pendingCount(sqs, QUEUE),
      (count) => count === 0,
    );
    expect(await transactionsOf(wallet.id)).toBe(1);
    expect(await deadLetterReasons()).toEqual([]);
  }, 30_000);

  test("messages waiting in memory keep their visibility while earlier ones are slow", async () => {
    const { queueName, dlqName } = await createRetryQueues(sqs, 1, 1);
    const overrides = { SQS_WAGER_QUEUE: queueName, SQS_WAGER_DLQ: dlqName, SQS_VISIBILITY_HEARTBEAT_MS: "300" };
    const first = await startConsumer(overrides);
    const second = await startConsumer(overrides);
    const wallet = await createWallet(api, "100.00");

    try {
      await lockWallet(wallet.id, async () => {
        for (let index = 0; index < 3; index += 1) {
          await sendRaw(sqs, queueName, envelope(wagerData(wallet)), wallet.id);
        }
        await eventually(waitingOnLocks, (total) => total > 0);
        await Bun.sleep(1_600);
      });

      await eventually(
        () => transactionsOf(wallet.id),
        (total) => total === 3,
      );
      await eventually(
        () => pendingCount(sqs, queueName),
        (count) => count === 0,
      );
      expect(await drain(sqs, dlqName)).toEqual([]);
      expect(await balanceOf(wallet.id)).toBe("70.00");
    } finally {
      await first.close();
      await second.close();
    }
  }, 30_000);

  test("visibility renewals never override the retry backoff", async () => {
    const { queueName, dlqName } = await createRetryQueues(sqs, 5);
    const fast = await startConsumer({
      SQS_WAGER_QUEUE: queueName,
      SQS_WAGER_DLQ: dlqName,
      SQS_VISIBILITY_HEARTBEAT_MS: "100",
    });
    const recorder = recordSettlementFailures(fast);
    const wallet = await createWallet(api, "100.00");

    try {
      await lockWallet(wallet.id, async () => {
        await sendRaw(sqs, queueName, envelope(wagerData(wallet)), wallet.id);
        await eventually(
          async () => recorder.failures.length,
          (total) => total > 0,
        );
      });
      const released = Date.now();

      await eventually(
        () => balanceOf(wallet.id),
        (balance) => balance === "90.00",
        10_000,
      );
      expect(Date.now() - released).toBeLessThan(10_000);
      expect(await transactionsOf(wallet.id)).toBe(1);
    } finally {
      recorder.restore();
      await fast.close();
    }
  }, 30_000);

  test("a message that keeps failing transiently reaches the dead-letter queue after the receive limit", async () => {
    const { queueName, dlqName } = await createRetryQueues(sqs, 2);
    const retrying = await startConsumer({ SQS_WAGER_QUEUE: queueName, SQS_WAGER_DLQ: dlqName });
    const wallet = await createWallet(api, "100.00");

    try {
      await lockWallet(wallet.id, async () => {
        await sendRaw(sqs, queueName, envelope(wagerData(wallet)), wallet.id);
        await eventually(
          () => drain(sqs, dlqName),
          (messages) => messages.length === 1,
          25_000,
        );
      });
    } finally {
      await retrying.close();
    }

    expect(await transactionsOf(wallet.id)).toBe(0);
    expect(await balanceOf(wallet.id)).toBe("100.00");
  }, 40_000);

  test("SIGTERM finishes the message in flight and returns the rest, so nothing is lost or duplicated", async () => {
    await consumer.close();
    const busy = await createWallet(api, "1000.00");
    const blocked = await createWallet(api, "100.00");
    const blockedMessage = id();
    for (let index = 0; index < 20; index += 1) {
      await sendRaw(sqs, QUEUE, envelope(wagerData(busy)), busy.id);
    }

    const child = Bun.spawn(["bun", "src/main.ts"], {
      env: { ...process.env, APP_ROLE: "consumer", LOG_LEVEL: "info" },
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    const readUntil = async (text: string) => {
      while (!output.includes(text)) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value);
      }
    };

    await readUntil("consumer started");
    await lockWallet(blocked.id, async () => {
      await sendRaw(sqs, QUEUE, envelope(wagerData(blocked), blockedMessage), blocked.id);
      await eventually(waitingOnLocks, (total) => total > 0);
      child.kill("SIGTERM");
      await Bun.sleep(300);
    });
    await readUntil("process stopped");
    await child.exited;

    const lines = output.split("\n");
    const drained = lines.findIndex((line) => line.includes("consumer drained"));
    const settledInFlight = lines.findIndex(
      (line) => line.includes('"msg":"message settled"') && line.includes(blockedMessage),
    );
    expect(drained).toBeGreaterThan(-1);
    expect(settledInFlight).toBeGreaterThan(-1);
    expect(settledInFlight).toBeLessThan(drained);
    expect(await balanceOf(blocked.id)).toBe("90.00");

    consumer = await startConsumer();
    await eventually(
      () => transactionsOf(busy.id),
      (total) => total === 20,
      20_000,
    );
    await eventually(
      () => pendingCount(sqs, QUEUE),
      (count) => count === 0,
    );
    expect(await balanceOf(busy.id)).toBe("800.00");
    expect(await transactionsOf(blocked.id)).toBe(1);
    expect(await deadLetterReasons()).toEqual([]);
    await expectLedgerMatchesBalances(api.orm);
  }, 45_000);
});
