import { MikroOrmModule } from "@mikro-orm/nestjs";
import { EntityManager } from "@mikro-orm/postgresql";
import { Module } from "@nestjs/common";
import { LOGGER } from "../core/core.module";
import {
  APPLICATION_LOGGER,
  type ApplicationLogger,
  CLOCK,
  type Clock,
  ID_GENERATOR,
  type IdGenerator,
} from "./application/ports/runtime.port";
import { WAGERING_UNIT_OF_WORK, type WageringUnitOfWork } from "./application/ports/wagering-unit-of-work.port";
import { OpenWalletUseCase } from "./application/use-cases/open-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "./application/use-cases/process-wager-transaction.use-case";
import { ReconcileWalletUseCase } from "./application/use-cases/reconcile-wallet.use-case";
import { WageringQueries } from "./application/use-cases/wagering-queries.use-case";
import { MikroOrmWageringUnitOfWork } from "./infrastructure/persistence/mikro-orm-wagering-unit-of-work";
import { WAGERING_SCHEMAS } from "./infrastructure/persistence/wagering.schemas";
import { PrometheusReconciliationMonitor, SystemClock, UuidV7Generator } from "./infrastructure/runtime";
import type { Registry } from "prom-client";
import { METRICS_REGISTRY } from "../core/observability/metrics";
import type { ReconciliationMonitor } from "./application/use-cases/reconcile-wallet.use-case";

const RECONCILIATION_MONITOR = Symbol("RECONCILIATION_MONITOR");

const runtime = [WAGERING_UNIT_OF_WORK, ID_GENERATOR, CLOCK, APPLICATION_LOGGER];

@Module({
  imports: [MikroOrmModule.forFeature(WAGERING_SCHEMAS)],
  providers: [
    {
      provide: WAGERING_UNIT_OF_WORK,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new MikroOrmWageringUnitOfWork(em),
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
      useFactory: (uow: WageringUnitOfWork, ids: IdGenerator, clock: Clock, logger: ApplicationLogger) =>
        new ProcessWagerTransactionUseCase(uow, ids, clock, logger),
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
  ],
  exports: [
    MikroOrmModule,
    WAGERING_UNIT_OF_WORK,
    ProcessWagerTransactionUseCase,
    OpenWalletUseCase,
    ReconcileWalletUseCase,
    WageringQueries,
  ],
})
export class WageringModule {}
