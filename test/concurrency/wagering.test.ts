import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  call,
  createWallet,
  expectLedgerMatchesBalances,
  startTestApi,
  submit,
  type TestApi,
  wagerBody,
} from "../support/api";

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi();
});

afterAll(async () => {
  await api.close();
});

const ledgerCount = async (walletId: string, direction: string) => {
  const [row] = await api.orm.em
    .getConnection()
    .execute<{ total: number }[]>(
      "select count(*)::int as total from wallet_ledger_entries where wallet_id = ? and direction = ?",
      [walletId, direction],
    );
  return row?.total ?? 0;
};

describe("concurrency", () => {
  test("the same BET sent 50 times in parallel debits once", async () => {
    const wallet = await createWallet(api, "100.00");
    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "10.00" });

    const replies = await Promise.all(Array.from({ length: 50 }, () => submit(api, body)));

    expect(replies.every((reply) => reply.status === 200)).toBe(true);
    expect(new Set(replies.map((reply) => reply.body.transactionId)).size).toBe(1);
    expect(replies.filter((reply) => !reply.body.idempotentReplay)).toHaveLength(1);
    expect(replies.every((reply) => reply.body.balance?.amount === "90.00")).toBe(true);
    expect(await ledgerCount(wallet.id, "DEBIT")).toBe(1);
    expect((await call(api, "GET", `/wallets/${wallet.id}`)).body).toMatchObject({
      balance: { amount: "90.00", currency: "BRL" },
      version: 2,
    });
  });

  test("the same key sent at once for two different wallets yields one success and one conflict", async () => {
    const first = await createWallet(api, "100.00");
    const second = await createWallet(api, "100.00");
    const externalTransactionId = `race-${Bun.randomUUIDv7()}`;
    const bodyFor = (wallet: { id: string; playerId: string }) =>
      wagerBody({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: "BET",
        amount: "10.00",
        externalTransactionId,
      });

    for (let round = 0; round < 5; round += 1) {
      const key = `provider-a:${externalTransactionId}:${round}`;
      const replies = await Promise.all([
        submit(api, { ...bodyFor(first), externalTransactionId: `${externalTransactionId}-${round}` }, key),
        submit(api, { ...bodyFor(second), externalTransactionId: `${externalTransactionId}-${round}` }, key),
      ]);

      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
    }
    expect((await ledgerCount(first.id, "DEBIT")) + (await ledgerCount(second.id, "DEBIT"))).toBe(5);
  });

  test("required scenario: 100.00 with two simultaneous 80.00 bets", async () => {
    const wallet = await createWallet(api, "100.00");
    const bets = [1, 2].map(() =>
      wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "80.00" }),
    );

    const replies = await Promise.all(bets.map((bet) => submit(api, bet)));

    const statuses = replies.map((reply) => reply.body.status).sort();
    expect(statuses).toEqual(["PROCESSED", "REJECTED"]);
    expect(replies.find((reply) => reply.body.status === "REJECTED")?.body.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(await ledgerCount(wallet.id, "DEBIT")).toBe(1);
    expect((await call(api, "GET", `/wallets/${wallet.id}`)).body).toMatchObject({
      balance: { amount: "20.00", currency: "BRL" },
    });

    const retries = await Promise.all(bets.map((bet) => submit(api, bet)));

    expect(retries.map((reply) => ({ ...reply.body, idempotentReplay: false }))).toEqual(
      replies.map((reply) => reply.body),
    );
    expect(retries.every((reply) => reply.body.idempotentReplay)).toBe(true);
    expect(await ledgerCount(wallet.id, "DEBIT")).toBe(1);
  });

  test("many different bets on one hot wallet never overdraw it", async () => {
    const wallet = await createWallet(api, "100.00");

    const replies = await Promise.all(
      Array.from({ length: 40 }, () =>
        submit(api, wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "7.00" })),
      ),
    );

    const processed = replies.filter((reply) => reply.body.status === "PROCESSED");
    expect(processed).toHaveLength(14);
    expect(replies.filter((reply) => reply.body.failureCode === "INSUFFICIENT_FUNDS")).toHaveLength(26);
    expect((await call(api, "GET", `/wallets/${wallet.id}`)).body).toMatchObject({
      balance: { amount: "2.00", currency: "BRL" },
      version: 15,
    });
  });

  test("a locked wallet does not block another wallet", async () => {
    const locked = await createWallet(api, "100.00");
    const free = await createWallet(api, "100.00");
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let lockTaken = () => {};
    const isLocked = new Promise<void>((resolve) => (lockTaken = resolve));

    const holder = api.orm.em.fork().transactional(async (em) => {
      await em
        .getConnection()
        .execute("select id from wallets where id = ? for update", [locked.id], "all", em.getTransactionContext());
      lockTaken();
      await held;
    });
    await isLocked;

    const blocked = submit(
      api,
      wagerBody({ walletId: locked.id, playerId: locked.playerId, kind: "BET", amount: "1.00" }),
    );
    const startedAt = Date.now();
    const freeReply = await submit(
      api,
      wagerBody({ walletId: free.id, playerId: free.playerId, kind: "BET", amount: "1.00" }),
    );
    const freeElapsed = Date.now() - startedAt;
    const stillBlocked = await Promise.race([blocked.then(() => false), Bun.sleep(300).then(() => true)]);

    release();
    await holder;
    const blockedReply = await blocked;

    expect(freeReply.status).toBe(200);
    expect(freeElapsed).toBeLessThan(1_000);
    expect(stillBlocked).toBe(true);
    expect(blockedReply.status).toBe(200);
  });

  test("a wallet locked longer than the lock timeout answers 503 with Retry-After", async () => {
    const wallet = await createWallet(api, "100.00");
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let lockTaken = () => {};
    const isLocked = new Promise<void>((resolve) => (lockTaken = resolve));

    const holder = api.orm.em.fork().transactional(async (em) => {
      await em
        .getConnection()
        .execute("select id from wallets where id = ? for update", [wallet.id], "all", em.getTransactionContext());
      lockTaken();
      await held;
    });
    await isLocked;

    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "1.00" });
    const reply = await submit(api, body);
    release();
    await holder;
    const retry = await submit(api, body);

    expect(reply.status).toBe(503);
    expect(reply.headers.get("retry-after")).toBe("1");
    expect(retry.status).toBe(200);
    expect(retry.body.idempotentReplay).toBe(false);
  }, 10_000);

  test("different wallets are processed in parallel without interfering", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet(api, "50.00")));

    const replies = await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 5 }, () =>
          submit(api, wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "10.00" })),
        ),
      ),
    );

    expect(replies.every((reply) => reply.body.status === "PROCESSED")).toBe(true);
    for (const wallet of wallets) {
      expect((await call(api, "GET", `/wallets/${wallet.id}`)).body).toMatchObject({
        balance: { amount: "0.00", currency: "BRL" },
        version: 6,
      });
    }
  });

  test("concurrent bets, wins and reversals keep every balance equal to its ledger", async () => {
    const wallet = await createWallet(api, "500.00");
    const bets = Array.from({ length: 20 }, () =>
      wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "10.00" }),
    );

    await Promise.all(bets.map((bet) => submit(api, bet)));
    await Promise.all([
      ...bets.slice(0, 10).map((bet) =>
        submit(
          api,
          wagerBody({
            walletId: wallet.id,
            playerId: wallet.playerId,
            kind: "REFUND",
            amount: "10.00",
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
        ),
      ),
      ...bets.slice(0, 10).map((bet) =>
        submit(
          api,
          wagerBody({
            walletId: wallet.id,
            playerId: wallet.playerId,
            kind: "ROLLBACK",
            amount: "10.00",
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
        ),
      ),
      ...Array.from({ length: 10 }, () =>
        submit(api, wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: "WIN", amount: "3.00" })),
      ),
    ]);

    expect((await call(api, "GET", `/wallets/${wallet.id}`)).body).toMatchObject({
      balance: { amount: "430.00", currency: "BRL" },
    });
    await expectLedgerMatchesBalances(api.orm);
  });
});
