import { MikroOrmModule } from "@mikro-orm/nestjs";
import { EntityManager } from "@mikro-orm/postgresql";
import { Module } from "@nestjs/common";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { Env } from "../core/config/env";
import { ENV, LOGGER } from "../core/core.module";
import { SQS_CLIENT } from "../core/messaging/sqs.client";
import { EVENT_PUBLISHER, type EventPublisher } from "./application/ports/event-publisher.port";
import {
  APPLICATION_LOGGER,
  type ApplicationLogger,
  CLOCK,
  type Clock,
  ID_GENERATOR,
  type IdGenerator,
} from "./application/ports/runtime.port";
import { WAGERING_METRICS, type WageringMetrics } from "./application/ports/wagering-metrics.port";
import { WAGERING_UNIT_OF_WORK, type WageringUnitOfWork } from "./application/ports/wagering-unit-of-work.port";
import { OpenWalletUseCase } from "./application/use-cases/open-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "./application/use-cases/process-wager-transaction.use-case";
import { PublishOutboxUseCase } from "./application/use-cases/publish-outbox.use-case";
import { ReconcileWalletUseCase } from "./application/use-cases/reconcile-wallet.use-case";
import { ResolvePendingReferencesUseCase } from "./application/use-cases/resolve-pending-references.use-case";
import { WageringQueries } from "./application/use-cases/wagering-queries.use-case";
import { SqsEventPublisher } from "./infrastructure/messaging/sqs-event-publisher";
import { MikroOrmWageringUnitOfWork } from "./infrastructure/persistence/mikro-orm-wagering-unit-of-work";
import { WAGERING_SCHEMAS } from "./infrastructure/persistence/wagering.schemas";
import {
  PrometheusReconciliationMonitor,
  PrometheusWageringMetrics,
  SystemClock,
  UuidV7Generator,
} from "./infrastructure/runtime";
import type { Registry } from "prom-client";
import { METRICS_REGISTRY } from "../core/observability/metrics";
import type { ReconciliationMonitor } from "./application/use-cases/reconcile-wallet.use-case";

const RECONCILIATION_MONITOR = Symbol("RECONCILIATION_MONITOR");

const runtime = [WAGERING_UNIT_OF_WORK, ID_GENERATOR, CLOCK, APPLICATION_LOGGER, WAGERING_METRICS];

@Module({
  imports: [MikroOrmModule.forFeature(WAGERING_SCHEMAS)],
  providers: [
    {
      provide: WAGERING_METRICS,
      inject: [METRICS_REGISTRY],
      useFactory: (registry: Registry) => new PrometheusWageringMetrics(registry),
    },
    {
      provide: WAGERING_UNIT_OF_WORK,
      inject: [EntityManager, WAGERING_METRICS],
      useFactory: (em: EntityManager, metrics: WageringMetrics) => new MikroOrmWageringUnitOfWork(em, metrics),
    },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    { provide: CLOCK, useClass: SystemClock },
    { provide: APPLICATION_LOGGER, useExisting: LOGGER },
    {
      provide: RECONCILIATION_MONITOR,
      inject: [METRICS_REGISTRY],
      useFactory: (registry: Registry) => new PrometheusReconciliationMonitor(registry),
    },
    {
      provide: ProcessWagerTransactionUseCase,
      inject: runtime,
      useFactory: (
        uow: WageringUnitOfWork,
        ids: IdGenerator,
        clock: Clock,
        logger: ApplicationLogger,
        metrics: WageringMetrics,
      ) => new ProcessWagerTransactionUseCase(uow, ids, clock, logger, metrics),
    },
    {
      provide: OpenWalletUseCase,
      inject: runtime,
      useFactory: (uow: WageringUnitOfWork, ids: IdGenerator, clock: Clock, logger: ApplicationLogger) =>
        new OpenWalletUseCase(uow, ids, clock, logger),
    },
    {
      provide: ReconcileWalletUseCase,
      inject: [WAGERING_UNIT_OF_WORK, APPLICATION_LOGGER, RECONCILIATION_MONITOR],
      useFactory: (uow: WageringUnitOfWork, logger: ApplicationLogger, monitor: ReconciliationMonitor) =>
        new ReconcileWalletUseCase(uow, logger, monitor),
    },
    {
      provide: WageringQueries,
      inject: [WAGERING_UNIT_OF_WORK],
      useFactory: (uow: WageringUnitOfWork) => new WageringQueries(uow),
    },
    {
      provide: EVENT_PUBLISHER,
      inject: [SQS_CLIENT, ENV, APPLICATION_LOGGER],
      useFactory: (sqs: SQSClient, env: Env, logger: ApplicationLogger) =>
        new SqsEventPublisher(sqs, env.sqs.eventsQueue, logger),
    },
    {
      provide: PublishOutboxUseCase,
      inject: [WAGERING_UNIT_OF_WORK, EVENT_PUBLISHER, CLOCK, APPLICATION_LOGGER, WAGERING_METRICS],
      useFactory: (
        uow: WageringUnitOfWork,
        publisher: EventPublisher,
        clock: Clock,
        logger: ApplicationLogger,
        metrics: WageringMetrics,
      ) => new PublishOutboxUseCase(uow, publisher, clock, logger, metrics),
    },
    {
      provide: ResolvePendingReferencesUseCase,
      inject: runtime,
      useFactory: (
        uow: WageringUnitOfWork,
        ids: IdGenerator,
        clock: Clock,
        logger: ApplicationLogger,
        metrics: WageringMetrics,
      ) => new ResolvePendingReferencesUseCase(uow, ids, clock, logger, metrics),
    },
  ],
  exports: [
    MikroOrmModule,
    WAGERING_UNIT_OF_WORK,
    ProcessWagerTransactionUseCase,
    OpenWalletUseCase,
    ReconcileWalletUseCase,
    WageringQueries,
    PublishOutboxUseCase,
    ResolvePendingReferencesUseCase,
    WAGERING_METRICS,
  ],
})
export class WageringModule {}
