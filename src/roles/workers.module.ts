import { BackgroundMetricsModule } from "../metrics/background-metrics.module";
import { Module } from "@nestjs/common";
import { WageringWorkersModule } from "../wagering/presentation/workers/wagering-workers.module";

@Module({ imports: [BackgroundMetricsModule, WageringWorkersModule] })
export class WorkersModule {}
