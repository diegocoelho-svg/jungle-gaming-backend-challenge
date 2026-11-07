import { join } from "node:path";
import { Migrator } from "@mikro-orm/migrations";
import { defineConfig, type Options } from "@mikro-orm/postgresql";
import type { Env } from "../config/env";

const CONNECTION_ACQUIRE_TIMEOUT_MS = 3_000;
const QUERY_TIMEOUT_MS = 10_000;

export const buildOrmConfig = (
  env: Pick<Env, "databaseUrl" | "dbPoolMax">,
  entities: NonNullable<Options["entities"]> = [],
) =>
  defineConfig({
    clientUrl: env.databaseUrl,
    entities,
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    pool: { min: 1, max: env.dbPoolMax },
    driverOptions: {
      connectionTimeoutMillis: CONNECTION_ACQUIRE_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
    },
    migrations: {
      path: join(import.meta.dir, "migrations"),
      glob: "!(*.d).{js,ts}",
      tableName: "mikro_orm_migrations",
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
