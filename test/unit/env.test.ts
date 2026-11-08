import { describe, expect, test } from "bun:test";
import { InvalidEnvError, loadEnv } from "../../src/core/config/env";

const valid = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
  SQS_ENDPOINT: "http://localhost:4566",
  SQS_WAGER_QUEUE: "wager-transactions.fifo",
  SQS_WAGER_DLQ: "wager-transactions-dlq.fifo",
  SQS_EVENTS_QUEUE: "wagering-events.fifo",
};

describe("loadEnv", () => {
  test("applies default values", () => {
    const env = loadEnv(valid);

    expect(env.appRole).toBe("api");
    expect(env.port).toBe(3000);
    expect(env.logLevel).toBe("info");
    expect(env.sqs.maxReceiveCount).toBe(5);
  });

  test.each(["api", "consumer", "workers"])("accepts role %s", (role) => {
    expect(loadEnv({ ...valid, APP_ROLE: role }).appRole).toBe(role as never);
  });

  test("keeps the visibility heartbeat below the queue visibility timeout", () => {
    expect(loadEnv(valid).sqs.visibilityHeartbeatMs).toBe(10_000);
    expect(loadEnv({ ...valid, SQS_VISIBILITY_HEARTBEAT_MS: "20000" }).sqs.visibilityHeartbeatMs).toBe(20_000);
    expect(loadEnv({ ...valid, SQS_VISIBILITY_HEARTBEAT_MS: "100" }).sqs.visibilityHeartbeatMs).toBe(100);
    expect(() => loadEnv({ ...valid, SQS_VISIBILITY_HEARTBEAT_MS: "20001" })).toThrow(InvalidEnvError);
    expect(() => loadEnv({ ...valid, SQS_VISIBILITY_HEARTBEAT_MS: "99" })).toThrow(InvalidEnvError);
  });

  test("rejects an unknown role", () => {
    expect(() => loadEnv({ ...valid, APP_ROLE: "admin" })).toThrow(InvalidEnvError);
  });

  test.each(["0", "-1", "1.5", "abc"])("rejects port %s", (port) => {
    expect(() => loadEnv({ ...valid, PORT: port })).toThrow(InvalidEnvError);
  });

  test("reports every problem at once", () => {
    try {
      loadEnv({ APP_ROLE: "admin" });
      throw new Error("should fail");
    } catch (error) {
      const { problems } = error as InvalidEnvError;

      expect(problems).toContain("DATABASE_URL is required");
      expect(problems).toContain("SQS_ENDPOINT is required");
      expect(problems.some((problem) => problem.startsWith("APP_ROLE"))).toBe(true);
    }
  });
});
