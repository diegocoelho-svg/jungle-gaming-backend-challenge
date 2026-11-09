import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import type { Registry } from "prom-client";
import type { Env } from "../core/config/env";
import { ENV, LOGGER } from "../core/core.module";
import type { Logger } from "../core/observability/logger";
import { METRICS_REGISTRY } from "../core/observability/metrics";

@Injectable()
export class MetricsServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private server?: ReturnType<typeof Bun.serve>;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(METRICS_REGISTRY) private readonly registry: Registry,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.metricsPort === undefined) return;
    this.server = Bun.serve({
      port: this.env.metricsPort,
      fetch: async (request) => {
        const { pathname } = new URL(request.url);
        if (pathname === "/metrics") {
          return new Response(await this.registry.metrics(), {
            headers: { "content-type": this.registry.contentType },
          });
        }
        if (pathname === "/health/live") return Response.json({ status: "ok" });
        return new Response("Not Found", { status: 404 });
      },
    });
    this.logger.info({ port: this.server.port }, "metrics server ready");
  }

  onApplicationShutdown(): void {
    this.server?.stop(true);
  }
}
