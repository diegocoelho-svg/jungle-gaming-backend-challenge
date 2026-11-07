import { describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { loadEnv } from "../../src/core/config/env";
import { buildOrmConfig } from "../../src/core/persistence/orm.config";

describe("connection pool", () => {
  test("an exhausted pool fails instead of waiting forever", async () => {
    const orm = await MikroORM.init(buildOrmConfig({ ...loadEnv(), dbPoolMax: 1 }));
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let started = () => {};
    const isHolding = new Promise<void>((resolve) => (started = resolve));

    const holder = orm.em.fork().transactional(async (em) => {
      await em.getConnection().execute("select 1", [], "run", em.getTransactionContext());
      started();
      await held;
    });
    await isHolding;

    const startedAt = Date.now();
    const failure = await orm.em
      .getConnection()
      .execute("select 1")
      .then(
        () => null,
        (error: Error) => error,
      );
    const elapsed = Date.now() - startedAt;

    release();
    await holder;
    await orm.close();

    expect(failure).toBeInstanceOf(Error);
    expect(elapsed).toBeLessThan(5_000);
  }, 10_000);

  test("respects the configured limit", async () => {
    const orm = await MikroORM.init(buildOrmConfig({ ...loadEnv(), dbPoolMax: 2 }));
    const backends = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const rows = await orm.em.getConnection().execute("select pg_backend_pid() as pid, pg_sleep(0.1)");
        return rows[0]?.pid as number;
      }),
    );
    await orm.close();

    expect(new Set(backends).size).toBeLessThanOrEqual(2);
  }, 10_000);
});
