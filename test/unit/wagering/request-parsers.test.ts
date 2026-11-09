import { describe, expect, test } from "bun:test";
import {
  encodeLedgerCursor,
  InvalidRequestError,
  parseLedgerQuery,
  parseOpenWallet,
  parseSubmitTransaction,
} from "../../../src/wagering/presentation/http/request-parsers";

const transaction = {
  providerId: "provider-a",
  externalTransactionId: "tx-1",
  playerId: "player-1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-1",
  gameId: "game-1",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

const problemsOf = (parse: () => unknown): string[] => {
  try {
    parse();
  } catch (error) {
    if (error instanceof InvalidRequestError) return error.problems;
    throw error;
  }
  throw new Error("expected InvalidRequestError");
};

describe("parseSubmitTransaction", () => {
  test("returns the command with the idempotency key and drops unknown fields", () => {
    const command = parseSubmitTransaction({ ...transaction, extra: "ignored" }, "provider-a:tx-1");

    expect(command).toEqual({ ...transaction, idempotencyKey: "provider-a:tx-1" } as never);
  });

  test("keeps an optional reference", () => {
    const command = parseSubmitTransaction(
      { ...transaction, kind: "REFUND", referenceExternalTransactionId: "tx-0" },
      "k",
    );

    expect(command.referenceExternalTransactionId).toBe("tx-0");
  });

  test("reports every problem at once", () => {
    const problems = problemsOf(() =>
      parseSubmitTransaction({ ...transaction, providerId: "", walletId: "not-a-uuid", kind: "OPENING" }, undefined),
    );

    expect(problems).toEqual([
      "Idempotency-Key header is required, up to 255 characters, without control characters",
      "providerId must be a non-empty string up to 255 characters",
      "walletId must be a UUID",
      "kind must be one of BET, WIN, LOSS, REFUND, ROLLBACK",
    ]);
  });

  test.each([
    [
      "a numeric amount",
      { money: { amount: 25, currency: "BRL" } },
      "money must be an object with string amount and currency",
    ],
    ["a missing money", { money: undefined }, "money must be an object with string amount and currency"],
    [
      "a text over 255 characters",
      { gameId: "g".repeat(256) },
      "gameId must be a non-empty string up to 255 characters",
    ],
    ["a control character", { roundId: "round\t1" }, "roundId must not contain control characters"],
    [
      "an empty reference",
      { referenceExternalTransactionId: "" },
      "referenceExternalTransactionId must be a non-empty string up to 255 characters",
    ],
  ])("rejects %s", (_, override, problem) => {
    expect(problemsOf(() => parseSubmitTransaction({ ...transaction, ...override }, "k"))).toEqual([problem]);
  });

  test.each([
    ["an array", []],
    ["null", null],
    ["a string", "BET"],
  ])("rejects %s as the body", (_, body) => {
    expect(problemsOf(() => parseSubmitTransaction(body, "k"))).toEqual(["body must be a JSON object"]);
  });

  test("rejects an idempotency key with a control character", () => {
    expect(problemsOf(() => parseSubmitTransaction(transaction, "key\u0000x"))).toHaveLength(1);
  });
});

describe("parseOpenWallet", () => {
  test("returns the command", () => {
    const body = { playerId: "player-1", initialBalance: { amount: "10.00", currency: "BRL" } };

    expect(parseOpenWallet(body)).toEqual(body);
  });

  test("rejects a missing player and a numeric balance together", () => {
    expect(problemsOf(() => parseOpenWallet({ initialBalance: { amount: 1, currency: "BRL" } }))).toEqual([
      "playerId must be a non-empty string up to 255 characters",
      "initialBalance must be an object with string amount and currency",
    ]);
  });
});

describe("parseLedgerQuery", () => {
  test("defaults to the first page of 50", () => {
    expect(parseLedgerQuery(undefined, undefined)).toEqual({ afterVersion: 0, limit: 50 });
  });

  test("decodes the cursor and the limit", () => {
    expect(parseLedgerQuery(encodeLedgerCursor(7), "20")).toEqual({ afterVersion: 7, limit: 20 });
  });

  test.each([
    ["a foreign cursor", Buffer.from("v2:7").toString("base64url"), undefined, "cursor is invalid"],
    ["a negative cursor", encodeLedgerCursor(-1), undefined, "cursor is invalid"],
    ["a repeated cursor", ["a", "b"], undefined, "cursor is invalid"],
    ["limit 0", undefined, "0", "limit must be an integer between 1 and 200"],
    ["limit 201", undefined, "201", "limit must be an integer between 1 and 200"],
    ["a fractional limit", undefined, "1.5", "limit must be an integer between 1 and 200"],
    ["a text limit", undefined, "ten", "limit must be an integer between 1 and 200"],
  ])("rejects %s", (_, cursor, limit, problem) => {
    expect(problemsOf(() => parseLedgerQuery(cursor, limit))).toEqual([problem]);
  });
});
