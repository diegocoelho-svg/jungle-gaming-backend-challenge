import { expect } from "bun:test";
import { type EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { loadEnv } from "../../src/core/config/env";
import { buildOrmConfig } from "../../src/core/persistence/orm.config";
import { openWallet } from "../../src/wagering/domain/services/open-wallet.service";
import { Money } from "../../src/wagering/domain/value-objects/money.vo";
import { ledgerEntryToSchema } from "../../src/wagering/infrastructure/persistence/mappers/wallet-ledger-entry.mapper";
import { walletToSchema } from "../../src/wagering/infrastructure/persistence/mappers/wallet.mapper";
import { wagerTransactionToSchema } from "../../src/wagering/infrastructure/persistence/mappers/wager-transaction.mapper";
import { WAGERING_SCHEMAS } from "../../src/wagering/infrastructure/persistence/wagering.schemas";

export const id = (): string => Bun.randomUUIDv7();
export const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });

export async function createTestOrm(): Promise<MikroORM> {
  return MikroORM.init(buildOrmConfig(loadEnv(), WAGERING_SCHEMAS));
}

export async function resetSchema(orm: MikroORM): Promise<void> {
  const connection = orm.em.getConnection();
  await connection.execute("drop schema public cascade");
  await connection.execute("create schema public");
  await orm.migrator.up();
}

export function sqlErrorCode(error: unknown): string | undefined {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const code = candidate?.code ?? candidate?.cause?.code;
  return typeof code === "string" ? code : undefined;
}

export async function expectSqlError(run: () => Promise<unknown>, code: string): Promise<void> {
  const error = await run().then(
    () => undefined,
    (failure: unknown) => failure,
  );

  expect(error).toBeDefined();
  expect(sqlErrorCode(error)).toBe(code);
}

export function inTransaction(
  orm: MikroORM,
  work: (sql: (query: string, params?: unknown[]) => Promise<unknown>) => Promise<void>,
) {
  return orm.em.fork().transactional(async (em) => {
    const sql = (query: string, params: unknown[] = []) =>
      em.getConnection().execute(query, params, "all", em.getTransactionContext());
    await work(sql);
  });
}

export async function persistOpenedWallet(
  orm: MikroORM,
  initialBalance = "100.00",
  playerId = id(),
): Promise<ReturnType<typeof openWallet>> {
  const opened = openWallet({
    walletId: id(),
    playerId,
    initialBalance: brl(initialBalance),
    openingTransactionId: id(),
    openingEntryId: id(),
    at: new Date(),
  });

  await orm.em.fork().transactional(async (em: EntityManager) => {
    em.persist(walletToSchema(opened.wallet));
    if (opened.opening) {
      em.persist(wagerTransactionToSchema(opened.opening.transaction));
      em.persist(ledgerEntryToSchema(opened.opening.entry));
    }
  });

  return opened;
}
