import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { HealthModule } from "../health/health.module";
import { MetricsModule } from "../metrics/metrics.module";
import { WageringHttpModule } from "../wagering/presentation/http/wagering-http.module";

@Module({ imports: [AuthModule, HealthModule, MetricsModule, WageringHttpModule] })
export class ApiModule {}
