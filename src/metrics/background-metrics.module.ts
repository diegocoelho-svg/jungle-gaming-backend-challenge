import { Module } from "@nestjs/common";
import { MetricsServer } from "./metrics-server";

@Module({ providers: [MetricsServer] })
export class BackgroundMetricsModule {}
