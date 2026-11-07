import { MikroORM } from "@mikro-orm/postgresql";
import { loadEnv } from "../src/core/config/env";
import { buildOrmConfig } from "../src/core/persistence/orm.config";

const direction = process.argv[2];
if (direction !== "up" && direction !== "down") {
  console.error("Usage: bun scripts/migrate.ts <up|down>");
  process.exit(1);
}

const orm = await MikroORM.init(buildOrmConfig(loadEnv({ ...process.env, APP_ROLE: "api" })));

try {
  const applied = await orm.migrator[direction]();
  console.log(JSON.stringify({ direction, migrations: applied.map((migration) => migration.name) }));
} finally {
  await orm.close();
}
