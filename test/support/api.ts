import "reflect-metadata";
import { expect } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { createApiApp } from "../../src/bootstrap";
import { loadEnv } from "../../src/core/config/env";
import { createTestOrm, id, resetSchema } from "./database";

export interface TestApi {
  url: string;
  orm: MikroORM;
  close(): Promise<void>;
}

export async function startTestApi(overrides: Record<string, string> = {}): Promise<TestApi> {
  const orm = await createTestOrm();
  await resetSchema(orm);

  const app = await createApiApp(loadEnv({ ...process.env, DB_POOL_MAX: "20", ...overrides }));
  await app.listen(0);
  const url = (await app.getUrl()).replace("[::1]", "localhost");

  return {
    url,
    orm,
    close: async () => {
      await app.close();
      await orm.close();
    },
  };
}

export interface Reply<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

export async function call<T = Record<string, unknown>>(
  api: TestApi,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply<T>> {
  const response = await fetch(`${api.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T, headers: response.headers };
}

export async function createWallet(api: TestApi, amount = "100.00", playerId = id()) {
  const reply = await call<{ id: string; playerId: string }>(api, "POST", "/wallets", {
    playerId,
    initialBalance: { amount, currency: "BRL" },
  });
  expect(reply.status).toBe(201);
  return reply.body;
}

export interface WagerInput {
  walletId: string;
  playerId: string;
  kind: string;
  amount: string;
  externalTransactionId?: string;
  referenceExternalTransactionId?: string;
  providerId?: string;
  roundId?: string;
}

export function wagerBody(input: WagerInput) {
  return {
    providerId: input.providerId ?? "provider-a",
    externalTransactionId: input.externalTransactionId ?? id(),
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId ?? "round-1",
    gameId: "fortune-chimp",
    kind: input.kind,
    money: { amount: input.amount, currency: "BRL" },
    ...(input.referenceExternalTransactionId && {
      referenceExternalTransactionId: input.referenceExternalTransactionId,
    }),
  };
}

export function submit(api: TestApi, body: ReturnType<typeof wagerBody>, idempotencyKey?: string) {
  return call<{
    transactionId: string;
    status: string;
    balance: { amount: string; currency: string } | null;
    failureCode?: string;
    idempotentReplay: boolean;
  }>(api, "POST", "/wagering/transactions", body, {
    "idempotency-key": idempotencyKey ?? `${body.providerId}:${body.externalTransactionId}`,
  });
}

export async function expectLedgerMatchesBalances(orm: MikroORM): Promise<void> {
  const rows = await orm.em.getConnection().execute<{ id: string; balance: string; ledger: string }[]>(
    `select w.id, w.balance,
            coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)::numeric(20, 2) as ledger
       from wallets w
       left join wallet_ledger_entries e on e.wallet_id = w.id
      group by w.id, w.balance`,
  );

  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect({ id: row.id, balance: row.balance }).toEqual({ id: row.id, balance: row.ledger });
  }
}
