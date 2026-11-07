import { GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { EntityManager } from "@mikro-orm/postgresql";
import { Module } from "@nestjs/common";
import type { Env } from "../core/config/env";
import { ENV } from "../core/core.module";
import { SQS_CLIENT } from "../core/messaging/sqs.client";
import { DEPENDENCY_PROBES, type DependencyProbe } from "./dependency-probe.port";
import { HealthController } from "./health.controller";

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: DEPENDENCY_PROBES,
      inject: [EntityManager, SQS_CLIENT, ENV],
      useFactory: (em: EntityManager, sqs: SQSClient, env: Env): DependencyProbe[] => [
        {
          name: "postgres",
          check: async () => {
            await em.getConnection().execute("select 1");
          },
        },
        {
          name: "sqs",
          check: async (signal) => {
            await sqs.send(new GetQueueUrlCommand({ QueueName: env.sqs.wagerQueue }), { abortSignal: signal });
          },
        },
      ],
    },
  ],
})
export class HealthModule {}
