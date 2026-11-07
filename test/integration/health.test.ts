import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApiApp } from "../../src/bootstrap";
import { loadEnv } from "../../src/core/config/env";

type App = Awaited<ReturnType<typeof createApiApp>>;

async function startApi(overrides: Record<string, string> = {}): Promise<{ app: App; url: string }> {
  const app = await createApiApp(loadEnv({ ...process.env, ...overrides }));
  await app.listen(0);
  return { app, url: await app.getUrl() };
}

async function setupQueues(): Promise<void> {
  const child = Bun.spawn(["bun", "scripts/setup-queues.ts"], { stdout: "ignore", stderr: "inherit" });
  expect(await child.exited).toBe(0);
}

describe("health", () => {
  let healthy: { app: App; url: string };

  beforeAll(async () => {
    await setupQueues();
    healthy = await startApi();
  });

  afterAll(async () => {
    await healthy.app.close();
  });

  test("ready returns 200 with real PostgreSQL and SQS", async () => {
    const response = await fetch(`${healthy.url}/health/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", checks: { postgres: "up", sqs: "up" } });
  });

  test("with PostgreSQL and SQS unreachable, ready returns 503 and live stays 200", async () => {
    const broken = await startApi({
      DATABASE_URL: "postgres://wagering:wagering@127.0.0.1:1/wagering",
      SQS_ENDPOINT: "http://127.0.0.1:1",
    });

    try {
      const ready = await fetch(`${broken.url}/health/ready`);
      const live = await fetch(`${broken.url}/health/live`);

      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ status: "unavailable", checks: { postgres: "down", sqs: "down" } });
      expect(live.status).toBe(200);
    } finally {
      await broken.app.close();
    }
  }, 10_000);

  test("ready returns 503 when the queue does not exist", async () => {
    const missing = await startApi({ SQS_WAGER_QUEUE: "missing-queue.fifo" });

    try {
      const response = await fetch(`${missing.url}/health/ready`);

      expect(response.status).toBe(503);
    } finally {
      await missing.app.close();
    }
  });

  test("generates a correlationId and reuses the caller's", async () => {
    const generated = await fetch(`${healthy.url}/health/live`);
    const reused = await fetch(`${healthy.url}/health/live`, { headers: { "x-correlation-id": "abc-123" } });
    const unsafe = await fetch(`${healthy.url}/health/live`, { headers: { "x-correlation-id": "abc 123 !" } });

    expect(generated.headers.get("x-correlation-id")).toBeTruthy();
    expect(reused.headers.get("x-correlation-id")).toBe("abc-123");
    expect(unsafe.headers.get("x-correlation-id")).not.toBe("abc 123 !");
  });
});

describe("process roles", () => {
  test.each(["consumer", "workers"])(
    "%s runs application shutdown on SIGTERM",
    async (role) => {
      const child = Bun.spawn(["bun", "src/main.ts"], {
        env: { ...process.env, APP_ROLE: role, LOG_LEVEL: "info" },
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

      await readUntil("background process ready");
      expect(output).toContain(`"role":"${role}"`);

      child.kill("SIGTERM");
      await readUntil("process stopped");
      await child.exited;

      expect(output).toContain('"msg":"process stopped"');
      expect(output).toContain('"context":"SIGTERM"');
    },
    15_000,
  );
});
