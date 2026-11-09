import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  call,
  createWallet,
  expectLedgerMatchesBalances,
  startTestApi,
  submit,
  type TestApi,
  wagerBody,
} from "../../support/api";
import { computePayloadHash } from "../../../src/wagering/domain/services/payload-hash.service";
import { id } from "../../support/database";

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi();
});

afterAll(async () => {
  await expectLedgerMatchesBalances(api.orm);
  await api.close();
});

const count = async (table: string, where = "true", params: unknown[] = []) => {
  const [row] = await api.orm.em
    .getConnection()
    .execute<{ total: number }[]>(`select count(*)::int as total from ${table} where ${where}`, params);
  return row?.total ?? 0;
};

describe("POST /wallets", () => {
  test("opens a wallet with an OPENING transaction, a credit entry and events in one go", async () => {
    const playerId = id();

    const reply = await call(api, "POST", "/wallets", {
      playerId,
      initialBalance: { amount: "1000.00", currency: "BRL" },
    });

    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ playerId, balance: { amount: "1000.00", currency: "BRL" }, version: 1 });
    const walletId = reply.body.id as string;
    expect(await count("wager_transactions", "wallet_id = ? and kind = 'OPENING'", [walletId])).toBe(1);
    expect(await count("wallet_ledger_entries", "wallet_id = ?", [walletId])).toBe(1);
    expect(await count("outbox_messages", "aggregate_id = ?", [walletId])).toBe(2);
  });

  test("a zero balance creates no transaction", async () => {
    const wallet = await createWallet(api, "0.00");

    expect(await count("wager_transactions", "wallet_id = ?", [wallet.id])).toBe(0);
  });

  test("a second wallet for the same player and currency is a conflict", async () => {
    const wallet = await createWallet(api);

    const reply = await call(api, "POST", "/wallets", {
      playerId: wallet.playerId,
      initialBalance: { amount: "5.00", currency: "BRL" },
    });

    expect(reply.status).toBe(409);
    expect(reply.body.error).toBe("WALLET_ALREADY_EXISTS");
  });

  test.each([
    ["missing player", { initialBalance: { amount: "1.00", currency: "BRL" } }],
    ["amount as number", { playerId: "p", initialBalance: { amount: 1, currency: "BRL" } }],
    ["one decimal place", { playerId: "p", initialBalance: { amount: "1.5", currency: "BRL" } }],
    ["negative amount", { playerId: "p", initialBalance: { amount: "-1.00", currency: "BRL" } }],
    ["invalid currency", { playerId: "p", initialBalance: { amount: "1.00", currency: "real" } }],
    ["a NUL byte in the player", { playerId: "a\u0000b", initialBalance: { amount: "1.00", currency: "BRL" } }],
  ])("rejects %s with 400", async (_, body) => {
    const reply = await call(api, "POST", "/wallets", body);

    expect(reply.status).toBe(400);
    expect(reply.body.error).toBe("INVALID_REQUEST");
  });
});

describe("POST /wagering/transactions", () => {
  test.each([
    ["a NUL byte in a text field", { gameId: "game\u0000x" }],
    ["a BET with a reference", { referenceExternalTransactionId: "tx-other" }],
  ])("rejects %s with 400 before touching the wallet", async (_, extra) => {
    const wallet = await createWallet(api, "100.00");

    const reply = await submit(api, {
      ...wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "10.00" }),
      ...extra,
    });

    expect(reply.status).toBe(400);
    expect((reply.body as unknown as { error: string }).error).toBe("INVALID_REQUEST");
    expect((await call(api, "GET", `/wallets/${wallet.id}`)).body).toMatchObject({ version: 1 });
  });

  test("processes a BET and returns the new balance", async () => {
    const wallet = await createWallet(api, "1000.00");

    const reply = await submit(
      api,
      wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "25.00" }),
    );

    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      status: "PROCESSED",
      balance: { amount: "975.00", currency: "BRL" },
      idempotentReplay: false,
    });
  });

  test("an identical retry returns the original response as a replay", async () => {
    const wallet = await createWallet(api, "100.00");
    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "10.00" });

    const first = await submit(api, body);
    await submit(api, wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "50.00" }));
    const replay = await submit(api, body);

    expect(replay.status).toBe(first.status);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.body.balance).toEqual({ amount: "90.00", currency: "BRL" });
  });

  test("the same key with a different payload is a conflict, not a replay", async () => {
    const wallet = await createWallet(api);
    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "10.00" });
    await submit(api, body, "key-1");

    const reply = await submit(api, { ...body, money: { amount: "11.00", currency: "BRL" } }, "key-1");

    expect(reply.status).toBe(409);
    expect((reply.body as unknown as { error: string }).error).toBe("IDEMPOTENCY_CONFLICT");
  });

  test("the same external id under another key is a conflict", async () => {
    const wallet = await createWallet(api);
    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "10.00" });
    await submit(api, body, "key-a");

    const reply = await submit(api, body, "key-b");

    expect(reply.status).toBe(409);
  });

  test("insufficient funds is a 422 business rejection with a failure code, persisted and replayable", async () => {
    const wallet = await createWallet(api, "10.00");
    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "25.00" });

    const reply = await submit(api, body);
    const replay = await submit(api, body);

    expect(reply.status).toBe(422);
    expect(reply.body).toMatchObject({
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
      balance: { amount: "10.00", currency: "BRL" },
    });
    expect(replay.status).toBe(422);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  test("a REFUND of a processed BET credits it back, once", async () => {
    const wallet = await createWallet(api, "100.00");
    const bet = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "30.00" });
    await submit(api, bet);

    const refund = await submit(
      api,
      wagerBody({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: "REFUND",
        amount: "30.00",
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    const second = await submit(
      api,
      wagerBody({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: "ROLLBACK",
        amount: "30.00",
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );

    expect(refund.body).toMatchObject({ status: "PROCESSED", balance: { amount: "100.00", currency: "BRL" } });
    expect(second.status).toBe(422);
    expect(second.body.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
  });

  test("a ROLLBACK before its BET is accepted as pending with 202", async () => {
    const wallet = await createWallet(api, "100.00");

    const reply = await submit(
      api,
      wagerBody({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: "ROLLBACK",
        amount: "10.00",
        referenceExternalTransactionId: id(),
      }),
    );

    expect(reply.status).toBe(202);
    expect(reply.body).toMatchObject({ status: "PENDING_REFERENCE", balance: null });
  });

  test("LOSS is processed without moving the balance", async () => {
    const wallet = await createWallet(api, "100.00");

    const reply = await submit(
      api,
      wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "LOSS", amount: "0.00" }),
    );

    expect(reply.status).toBe(200);
    expect(reply.body.balance).toEqual({ amount: "100.00", currency: "BRL" });
  });

  test("a replay of a FAILED transaction answers 500, distinct from a business rejection", async () => {
    const wallet = await createWallet(api, "100.00");
    const body = wagerBody({
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind: "REFUND",
      amount: "10.00",
      referenceExternalTransactionId: id(),
    });
    const payloadHash = computePayloadHash(body);
    await api.orm.em.getConnection().execute(
      `insert into wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id,
         game_id, kind, amount, currency, reference_external_transaction_id, status, failure_code, created_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'REFUND', 10, 'BRL', ?, 'FAILED', 'INFRASTRUCTURE_FAILURE', now())`,
      [
        id(),
        body.providerId,
        body.externalTransactionId,
        `${body.providerId}:${body.externalTransactionId}`,
        payloadHash,
        wallet.id,
        wallet.playerId,
        body.roundId,
        body.gameId,
        body.referenceExternalTransactionId,
      ],
    );

    const reply = await submit(api, body);

    expect(reply.status).toBe(500);
    expect(reply.body).toMatchObject({
      status: "FAILED",
      failureCode: "INFRASTRUCTURE_FAILURE",
      idempotentReplay: true,
    });
  });

  test("an unknown wallet is a 404", async () => {
    const reply = await submit(api, wagerBody({ walletId: id(), playerId: id(), kind: "BET", amount: "1.00" }));

    expect(reply.status).toBe(404);
  });

  test("a missing Idempotency-Key is a 400", async () => {
    const wallet = await createWallet(api);

    const reply = await call(
      api,
      "POST",
      "/wagering/transactions",
      wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "1.00" }),
    );

    expect(reply.status).toBe(400);
  });

  test.each([
    ["OPENING", { kind: "OPENING" }],
    ["an unknown kind", { kind: "JACKPOT" }],
    ["a reserved provider", { providerId: "internal" }],
    ["a walletId that is not a UUID", { walletId: "wallet-1" }],
    ["a float amount", { money: { amount: 25.5, currency: "BRL" } }],
    ["more than 2 decimals", { money: { amount: "25.001", currency: "BRL" } }],
    ["REFUND without reference", { kind: "REFUND" }],
    ["a zero BET", { money: { amount: "0.00", currency: "BRL" } }],
  ])("rejects %s with 400", async (_, override) => {
    const wallet = await createWallet(api);
    const body = {
      ...wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "1.00" }),
      ...override,
    };

    const reply = await call(api, "POST", "/wagering/transactions", body, { "idempotency-key": id() });

    expect(reply.status).toBe(400);
  });

  test("writes the transaction, ledger, wallet and outbox atomically", async () => {
    const wallet = await createWallet(api, "100.00");
    const connection = api.orm.em.getConnection();
    await connection.execute("alter table outbox_messages rename to outbox_messages_unavailable");

    let reply;
    try {
      reply = await submit(
        api,
        wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "10.00" }),
      );
    } finally {
      await connection.execute("alter table outbox_messages_unavailable rename to outbox_messages");
    }

    expect(reply.status).toBe(500);
    expect(await count("wager_transactions", "wallet_id = ? and kind = 'BET'", [wallet.id])).toBe(0);
    expect(await count("wallet_ledger_entries", "wallet_id = ?", [wallet.id])).toBe(1);
    const current = await call(api, "GET", `/wallets/${wallet.id}`);
    expect(current.body).toMatchObject({ balance: { amount: "100.00", currency: "BRL" }, version: 1 });
  });

  test("a settled transaction emits its events to the outbox", async () => {
    const wallet = await createWallet(api, "100.00");

    await submit(api, wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "10.00" }));
    await submit(api, wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "500.00" }));
    await submit(api, wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "LOSS", amount: "0.00" }));

    const rows = await api.orm.em
      .getConnection()
      .execute<{ event_type: string }[]>(
        "select event_type from outbox_messages where aggregate_id = ? order by occurred_at, event_type",
        [wallet.id],
      );
    const types = rows.map((row) => row.event_type);

    expect(types.filter((type) => type === "WalletBalanceChanged")).toHaveLength(2);
    expect(types.filter((type) => type === "WagerTransactionProcessed")).toHaveLength(3);
    expect(types.filter((type) => type === "WagerTransactionRejected")).toHaveLength(1);
  });
});

describe("queries", () => {
  test("GET /wallets/:id returns the current balance", async () => {
    const wallet = await createWallet(api, "50.00");

    const reply = await call(api, "GET", `/wallets/${wallet.id}`);

    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ id: wallet.id, balance: { amount: "50.00", currency: "BRL" }, version: 1 });
  });

  test.each(["/wallets/not-a-uuid", `/wallets/${id()}`])("GET %s returns 404", async (path) => {
    expect((await call(api, "GET", path)).status).toBe(404);
  });

  test("the ledger is paginated with a stable opaque cursor", async () => {
    const wallet = await createWallet(api, "100.00");
    for (let index = 0; index < 4; index += 1) {
      await submit(api, wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "1.00" }));
    }

    const first = await call<{ entries: { walletVersion: number }[]; nextCursor: string | null }>(
      api,
      "GET",
      `/wallets/${wallet.id}/ledger?limit=2`,
    );
    const second = await call<{ entries: { walletVersion: number }[]; nextCursor: string | null }>(
      api,
      "GET",
      `/wallets/${wallet.id}/ledger?limit=2&cursor=${first.body.nextCursor}`,
    );
    const last = await call<{ entries: { walletVersion: number }[]; nextCursor: string | null }>(
      api,
      "GET",
      `/wallets/${wallet.id}/ledger?limit=2&cursor=${second.body.nextCursor}`,
    );

    expect(first.body.entries.map((entry) => entry.walletVersion)).toEqual([1, 2]);
    expect(second.body.entries.map((entry) => entry.walletVersion)).toEqual([3, 4]);
    expect(last.body.entries.map((entry) => entry.walletVersion)).toEqual([5]);
    expect(last.body.nextCursor).toBeNull();
  });

  test.each(["cursor=bad", "limit=0", "limit=201", "limit=abc"])(
    "an invalid ledger query (%s) is a 400",
    async (query) => {
      const wallet = await createWallet(api);

      expect((await call(api, "GET", `/wallets/${wallet.id}/ledger?${query}`)).status).toBe(400);
    },
  );

  test("a transaction can be read by id and by provider external id", async () => {
    const wallet = await createWallet(api, "100.00");
    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "5.00" });
    const submitted = await submit(api, body);

    const byId = await call(api, "GET", `/wagering/transactions/${submitted.body.transactionId}`);
    const byProvider = await call(
      api,
      "GET",
      `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`,
    );

    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ id: submitted.body.transactionId, status: "PROCESSED", kind: "BET" });
    expect(byProvider.body).toEqual(byId.body);
    expect(
      (await call(api, "GET", `/providers/provider-b/wagering/transactions/${body.externalTransactionId}`)).status,
    ).toBe(404);
  });

  test("a control character in the provider lookup is a 404, not a database failure", async () => {
    const reply = await call(api, "GET", "/providers/provider-a/wagering/transactions/tx%00x");

    expect(reply.status).toBe(404);
    expect(reply.body.error).toBe("TRANSACTION_NOT_FOUND");
  });
});

describe("POST /wallets/:id/reconciliation", () => {
  test("reports a consistent wallet", async () => {
    const wallet = await createWallet(api, "100.00");
    await submit(api, wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "25.00" }));

    const reply = await call(api, "POST", `/wallets/${wallet.id}/reconciliation`);

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: "75.00", currency: "BRL" },
      calculatedBalance: { amount: "75.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test("flags a divergence without correcting it", async () => {
    const wallet = await createWallet(api, "100.00");
    const connection = api.orm.em.getConnection();
    await connection.execute("alter table wallets disable trigger wallets_match_ledger");
    await connection.execute("alter table wallets disable trigger wallets_version_rules");
    try {
      await connection.execute("update wallets set balance = 90 where id = ?", [wallet.id]);
    } finally {
      await connection.execute("alter table wallets enable trigger wallets_match_ledger");
      await connection.execute("alter table wallets enable trigger wallets_version_rules");
    }

    const reply = await call(api, "POST", `/wallets/${wallet.id}/reconciliation`);
    const after = await call(api, "GET", `/wallets/${wallet.id}`);

    expect(reply.body).toMatchObject({
      consistent: false,
      storedBalance: { amount: "90.00", currency: "BRL" },
      calculatedBalance: { amount: "100.00", currency: "BRL" },
      difference: { amount: "-10.00", currency: "BRL" },
    });
    expect(after.body).toMatchObject({ balance: { amount: "90.00", currency: "BRL" } });
    const metrics = await fetch(`${api.url}/metrics`).then((response) => response.text());
    expect(metrics).toMatch(/^wagering_reconciliation_divergences_total\{[^}]*\} 1$/m);

    await connection.execute("alter table wallets disable trigger wallets_match_ledger");
    await connection.execute("alter table wallets disable trigger wallets_version_rules");
    try {
      await connection.execute("update wallets set balance = 100 where id = ?", [wallet.id]);
    } finally {
      await connection.execute("alter table wallets enable trigger wallets_match_ledger");
      await connection.execute("alter table wallets enable trigger wallets_version_rules");
    }
  });
});
