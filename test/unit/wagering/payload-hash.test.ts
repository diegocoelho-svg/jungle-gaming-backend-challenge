import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  computePayloadHash,
  type WagerPayload,
} from "../../../src/wagering/domain/services/payload-hash.service";

const payload: WagerPayload = {
  providerId: "provider-a",
  externalTransactionId: "tx-1",
  playerId: "player-1",
  walletId: "wallet-1",
  roundId: "round-1",
  gameId: "game-1",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

describe("canonicalJson", () => {
  test("sorts keys at every level", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test("ignores undefined and keeps array order", () => {
    expect(canonicalJson({ a: undefined, b: [2, 1] })).toBe('{"b":[2,1]}');
  });
});

describe("computePayloadHash", () => {
  test("is a stable hexadecimal SHA-256", () => {
    expect(computePayloadHash(payload)).toMatch(/^[0-9a-f]{64}$/);
    expect(computePayloadHash(payload)).toBe(computePayloadHash({ ...payload }));
  });

  test("does not depend on key order", () => {
    const reordered: WagerPayload = {
      money: { currency: "BRL", amount: "25.00" },
      kind: "BET",
      gameId: "game-1",
      roundId: "round-1",
      walletId: "wallet-1",
      playerId: "player-1",
      externalTransactionId: "tx-1",
      providerId: "provider-a",
    };

    expect(computePayloadHash(reordered)).toBe(computePayloadHash(payload));
  });

  test("an empty reference differs from a missing one", () => {
    expect(computePayloadHash({ ...payload, referenceExternalTransactionId: "" })).not.toBe(
      computePayloadHash(payload),
    );
  });

  test("ignores non-business fields", () => {
    const withTransport = { ...payload, idempotencyKey: "provider-a:tx-1", messageId: "m-1" };

    expect(computePayloadHash(withTransport)).toBe(computePayloadHash(payload));
  });

  test.each<[string, Partial<WagerPayload>]>([
    ["providerId", { providerId: "provider-b" }],
    ["externalTransactionId", { externalTransactionId: "tx-2" }],
    ["playerId", { playerId: "player-2" }],
    ["walletId", { walletId: "wallet-2" }],
    ["roundId", { roundId: "round-2" }],
    ["gameId", { gameId: "game-2" }],
    ["kind", { kind: "WIN" }],
    ["amount", { money: { amount: "25.01", currency: "BRL" } }],
    ["currency", { money: { amount: "25.00", currency: "USD" } }],
    ["reference", { referenceExternalTransactionId: "tx-0" }],
  ])("changes when %s changes", (_, change) => {
    expect(computePayloadHash({ ...payload, ...change })).not.toBe(computePayloadHash(payload));
  });
});
