import type { SQSClient } from "@aws-sdk/client-sqs";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { type DynamicModule, Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import type { Env } from "./config/env";
import { createSqsClient, SQS_CLIENT } from "./messaging/sqs.client";
import { createLogger, type Logger } from "./observability/logger";
import { buildOrmConfig } from "./persistence/orm.config";

export const ENV = Symbol("ENV");
export const LOGGER = Symbol("LOGGER");

@Global()
@Module({})
export class CoreModule implements OnApplicationShutdown {
  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  static forRoot(env: Env): DynamicModule {
    return {
      module: CoreModule,
      imports: [MikroOrmModule.forRoot(buildOrmConfig(env))],
      providers: [
        { provide: ENV, useValue: env },
        { provide: LOGGER, useValue: createLogger({ level: env.logLevel, role: env.appRole }) },
        { provide: SQS_CLIENT, useValue: createSqsClient(env) },
      ],
      exports: [ENV, LOGGER, SQS_CLIENT],
    };
  }

  onApplicationShutdown(signal?: string): void {
    this.sqs.destroy();
    this.logger.info({ context: signal }, "process stopped");
  }
}
