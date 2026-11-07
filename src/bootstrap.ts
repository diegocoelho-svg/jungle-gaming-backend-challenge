import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import type { Env } from "./core/config/env";
import { NestLoggerAdapter } from "./core/observability/logger";
import { correlationMiddleware } from "./core/observability/correlation.middleware";
import { LOGGER } from "./core/core.module";

export async function createApiApp(env: Env) {
  const app = await NestFactory.create(AppModule.forRoot({ ...env, appRole: "api" }), { bufferLogs: true });
  app.useLogger(new NestLoggerAdapter(app.get(LOGGER, { strict: false })));
  app.use(correlationMiddleware);
  app.enableShutdownHooks();
  return app;
}

async function runApi(env: Env): Promise<void> {
  const app = await createApiApp(env);
  await app.listen(env.port);
  app.get(LOGGER, { strict: false }).info({ port: env.port }, "api ready");
}

async function runBackground(env: Env): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(env), { bufferLogs: true });
  app.useLogger(new NestLoggerAdapter(app.get(LOGGER, { strict: false })));
  app.enableShutdownHooks();

  setInterval(() => undefined, 2 ** 30);
  app.get(LOGGER, { strict: false }).info("background process ready");
}

export function run(env: Env): Promise<void> {
  return env.appRole === "api" ? runApi(env) : runBackground(env);
}
