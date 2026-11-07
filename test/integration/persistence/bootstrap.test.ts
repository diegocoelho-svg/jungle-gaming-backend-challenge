import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EntityManager } from "@mikro-orm/postgresql";
import { createApiApp } from "../../../src/bootstrap";
import { loadEnv } from "../../../src/core/config/env";
import { WAGERING_SCHEMAS } from "../../../src/wagering/infrastructure/persistence/wagering.schemas";
import { WalletSchema } from "../../../src/wagering/infrastructure/persistence/schemas/wallet.schema";
import { createTestOrm, persistOpenedWallet, resetSchema } from "../../support/database";

type App = Awaited<ReturnType<typeof createApiApp>>;

let app: App;

beforeAll(async () => {
  const orm = await createTestOrm();
  await resetSchema(orm);
  await persistOpenedWallet(orm, "42.00");
  await orm.close();

  app = await createApiApp(loadEnv());
  await app.init();
});

afterAll(async () => {
  await app.close();
});

describe("application bootstrap", () => {
  test("registers every wagering record in the runtime ORM", () => {
    const metadata = app.get(EntityManager).getMetadata();

    for (const schema of WAGERING_SCHEMAS) {
      expect(metadata.find(schema.meta.class)).toBeDefined();
    }
  });

  test("queries wagering tables through the application entity manager", async () => {
    const wallets = await app.get(EntityManager).fork().find(WalletSchema, {});

    expect(wallets.map((wallet) => wallet.balance)).toEqual(["42.00"]);
  });
});
