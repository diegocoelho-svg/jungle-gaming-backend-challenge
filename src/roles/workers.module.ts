import { Module } from "@nestjs/common";
import { WageringWorkersModule } from "../wagering/presentation/workers/wagering-workers.module";

@Module({ imports: [WageringWorkersModule] })
export class WorkersModule {}
