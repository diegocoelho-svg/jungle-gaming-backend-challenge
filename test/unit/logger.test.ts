import { describe, expect, test } from "bun:test";
import { createLogger, NestLoggerAdapter } from "../../src/core/observability/logger";
import { runWithRequestContext } from "../../src/core/observability/request-context";

function captureLogger() {
  const lines: string[] = [];
  const logger = createLogger({ level: "info", role: "test" }, { write: (line: string) => void lines.push(line) });
  return { logger, raw: () => lines.at(-1) ?? "", read: () => JSON.parse(lines.at(-1) ?? "{}") };
}

describe("logger", () => {
  test("writes JSON with context tracing fields", () => {
    const { logger, read } = captureLogger();

    runWithRequestContext({ correlationId: "c-1", walletId: "w-1", providerId: "p-1" }, () => logger.info("processed"));

    expect(read()).toMatchObject({
      msg: "processed",
      role: "test",
      correlationId: "c-1",
      walletId: "w-1",
      providerId: "p-1",
    });
  });

  test("works outside a context", () => {
    const { logger, read } = captureLogger();

    logger.info("no context");

    expect(read().msg).toBe("no context");
    expect(read().correlationId).toBeUndefined();
  });

  test.each([
    ["direct", { money: { amount: "25.00" } }],
    ["nested", { event: { data: { money: { amount: "25.00" } } } }],
    ["deeply nested", { a: { b: { c: { d: { balance: "25.00" } } } } }],
    ["unexpected field name", { betAmount: "25.00" }],
    ["object inside err", { err: { payload: { money: { amount: "25.00" } } } }],
    ["object in an allowed field", { walletId: { money: { amount: "25.00" } } }],
    ["text in stack", { stack: "amount 25.00" }],
    ["extra property on Error", { err: Object.assign(new Error("failed"), { money: "25.00" }) }],
    ["Error message", { err: new Error("insufficient funds: money.amount=25.00") }],
    ["amount with extra decimals in Error", { err: new Error("amount 25.001") }],
  ])("does not leak financial amounts: %s", (_, fields) => {
    const { logger, raw } = captureLogger();

    logger.info(fields, "event");

    expect(raw()).toContain("event");
    expect(raw()).not.toContain("25.00");
  });

  test("keeps the stack of an Error", () => {
    const { logger, read } = captureLogger();

    logger.error({ err: new Error("failed") }, "error");

    expect(read().err.message).toBe("failed");
    expect(read().err.stack).toContain("logger.test.ts");
  });

  test.each<[string, (logger: ReturnType<typeof createLogger>) => void]>([
    ["plain string", (logger) => logger.error("balance 25.00")],
    ["string with an argument", (logger) => logger.error("balance %s", "25.00")],
    ["Error as the only argument", (logger) => logger.error(new Error("balance 25.00"))],
    ["object with err and no message", (logger) => logger.error({ err: new Error("balance 25.00") })],
    ["object with a message", (logger) => logger.error({ err: new Error("x") }, "balance 25.00")],
    ["Error and a message with an amount", (logger) => logger.error(new Error("x"), "balance 25.00")],
    ["Error and undefined", (logger) => logger.error(new Error("balance 25.00"), undefined as never)],
    ["object interpolation", (logger) => logger.error("balance %o", { amount: "25.00" })],
    ["interpolation with fields", (logger) => logger.error({ walletId: "w" }, "balance %j", { amount: "25.00" })],
  ])("does not leak amounts in any call shape: %s", (_, call) => {
    const { logger, raw } = captureLogger();

    call(logger);

    expect(raw()).toContain("[REDACTED]");
    expect(raw()).not.toContain("25.00");
  });

  test("keeps the error text and hides only the amount", () => {
    const { logger, read } = captureLogger();

    logger.error({ err: new Error("insufficient funds: 25.00") }, "error");

    expect(read().err.message).toBe("insufficient funds: [REDACTED]");
  });

  test("keeps the real error class", () => {
    const { logger, read } = captureLogger();

    logger.error({ err: new TypeError("failed") }, "error");

    expect(read().err.type).toBe("TypeError");
  });
});

describe("NestLoggerAdapter", () => {
  const STACK = "Error: failed\n    at handler (app.ts:1:1)";

  test("keeps stack and context in error(message, stack, context)", () => {
    const { logger, read } = captureLogger();

    new NestLoggerAdapter(logger).error("failed", STACK, "ExceptionsHandler");

    expect(read()).toMatchObject({ msg: "failed", stack: STACK, context: "ExceptionsHandler" });
  });

  test("hides amounts in NestJS messages and stacks", () => {
    const { logger, raw } = captureLogger();

    new NestLoggerAdapter(logger).error("failed with 25.00", "Error: 25.00\n    at handler (app.ts:1:1)", "Handler");

    expect(raw()).not.toContain("25.00");
  });

  test("treats a plain second argument as context", () => {
    const { logger, read } = captureLogger();

    new NestLoggerAdapter(logger).error("failed", "ExceptionsHandler");

    expect(read().context).toBe("ExceptionsHandler");
    expect(read().stack).toBeUndefined();
  });
});
