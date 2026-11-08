import { Controller, Get, Header, Inject } from "@nestjs/common";
import type { Registry } from "prom-client";
import { Public } from "../auth/auth.guard";
import { METRICS_REGISTRY } from "../core/observability/metrics";

@Public()
@Controller("metrics")
export class MetricsController {
  constructor(@Inject(METRICS_REGISTRY) private readonly registry: Registry) {}

  @Get()
  @Header("content-type", "text/plain; version=0.0.4")
  metrics(): Promise<string> {
    return this.registry.metrics();
  }
}
