import { collectDefaultMetrics, Registry } from "prom-client";

export const METRICS_REGISTRY = Symbol("METRICS_REGISTRY");

export function createMetricsRegistry(role: string): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service: "wagering-processor", role });
  collectDefaultMetrics({ register: registry });
  return registry;
}
