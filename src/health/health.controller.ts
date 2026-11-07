import { Controller, Get, HttpStatus, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import { DEPENDENCY_PROBES, type DependencyProbe } from "./dependency-probe.port";
import { Public } from "../auth/auth.guard";

const PROBE_DEADLINE_MS = 2_000;

async function finishesInTime(check: Promise<void>): Promise<boolean> {
  let timer: Timer | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), PROBE_DEADLINE_MS);
  });

  try {
    return await Promise.race([check.then(() => true), deadline]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

@Public()
@Controller("health")
export class HealthController {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(@Inject(DEPENDENCY_PROBES) private readonly probes: DependencyProbe[]) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(@Res() res: Response): Promise<void> {
    const results = await Promise.all(
      this.probes.map(async (probe) => [probe.name, await finishesInTime(this.check(probe))] as const),
    );
    const ready = results.every(([, reachable]) => reachable);

    res.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({
      status: ready ? "ok" : "unavailable",
      checks: Object.fromEntries(results.map(([name, reachable]) => [name, reachable ? "up" : "down"])),
    });
  }

  private check(probe: DependencyProbe): Promise<void> {
    const running = this.inFlight.get(probe.name);
    if (running) return running;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_DEADLINE_MS);
    const started = probe.check(controller.signal).finally(() => {
      clearTimeout(timer);
      this.inFlight.delete(probe.name);
    });

    this.inFlight.set(probe.name, started);
    return started;
  }
}
