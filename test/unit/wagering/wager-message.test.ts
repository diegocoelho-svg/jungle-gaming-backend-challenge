import { describe, expect, test } from "bun:test";
import { InvalidRequestError } from "../../../src/wagering/presentation/http/request-parsers";
import { parseWagerMessage } from "../../../src/wagering/presentation/messaging/wager-message.parser";
import { retryDelaySeconds } from "../../../src/wagering/presentation/messaging/wager-transactions.consumer";

const data = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  idempotencyKey: "provider-a:transaction-123",
  playerId: "player-1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

const body = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    messageId: "msg-123",
    type: "WagerTransactionRequested",
    occurredAt: "2026-07-29T15:00:00.000Z",
    data,
    ...overrides,
  });

describe("wager message parser", () => {
  test("parses the envelope into the same command used by HTTP", () => {
    const parsed = parseWagerMessage(body({ correlationId: "corr-1" }));

    expect(parsed.messageId).toBe("msg-123");
    expect(parsed.correlationId).toBe("corr-1");
    expect(parsed.command).toEqual({ ...data, kind: "BET" } as never);
  });

  test.each([
    ["invalid JSON", "{"],
    ["an array", "[]"],
    ["a missing message id", body({ messageId: undefined })],
    ["an unsafe message id", body({ messageId: "a b" })],
    ["another message type", body({ type: "Other" })],
    ["missing data", body({ data: undefined })],
    ["a missing idempotency key", body({ data: { ...data, idempotencyKey: undefined } })],
    ["an OPENING kind", body({ data: { ...data, kind: "OPENING" } })],
    ["a numeric amount", body({ data: { ...data, money: { amount: 25, currency: "BRL" } } })],
  ])("rejects %s", (_, raw) => {
    expect(() => parseWagerMessage(raw)).toThrow(InvalidRequestError);
  });
});

describe("retry backoff", () => {
  test("doubles from 2 seconds and is capped at 5 minutes", () => {
    expect([1, 2, 3, 4, 5].map(retryDelaySeconds)).toEqual([2, 4, 8, 16, 32]);
    expect(retryDelaySeconds(20)).toBe(300);
  });
});
