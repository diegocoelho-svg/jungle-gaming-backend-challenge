import "reflect-metadata";
import { describe, expect, mock, test } from "bun:test";
import type { Response } from "express";
import type { DependencyProbe } from "../../src/health/dependency-probe.port";
import { HealthController } from "../../src/health/health.controller";

function fakeResponse() {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
  };
  return { res: res as unknown as Response, captured };
}

describe("HealthController", () => {
  test("live returns ok even when every dependency fails", () => {
    const check = mock(() => Promise.reject(new Error("unavailable")));
    const controller = new HealthController([{ name: "postgres", check }]);

    expect(controller.live()).toEqual({ status: "ok" });
    expect(check).not.toHaveBeenCalled();
  });

  test("a hung probe is aborted, reported down, and concurrent calls do not pile up", async () => {
    let received: AbortSignal | undefined;
    const check = mock((signal: AbortSignal) => {
      received = signal;
      return new Promise<void>(() => undefined);
    });
    const probe: DependencyProbe = { name: "sqs", check };
    const controller = new HealthController([probe]);
    const first = fakeResponse();
    const second = fakeResponse();

    await Promise.all([controller.ready(first.res), controller.ready(second.res)]);

    expect(check).toHaveBeenCalledTimes(1);
    expect(received?.aborted).toBe(true);
    expect(first.captured).toEqual({ status: 503, body: { status: "unavailable", checks: { sqs: "down" } } });
    expect(second.captured.status).toBe(503);
  }, 5_000);

  test("a probe that ignores abort starts no new operation on later calls", async () => {
    let finish = () => {};
    const check = mock(() => new Promise<void>((resolve) => (finish = resolve)));
    const controller = new HealthController([{ name: "postgres", check }]);
    const late = fakeResponse();

    await controller.ready(fakeResponse().res);
    await controller.ready(late.res);

    expect(check).toHaveBeenCalledTimes(1);
    expect(late.captured.status).toBe(503);

    finish();
    await Bun.sleep(0);
    await controller.ready(fakeResponse().res);

    expect(check).toHaveBeenCalledTimes(2);
  }, 8_000);

  test("after finishing, the next call runs a new check", async () => {
    const check = mock(() => Promise.resolve());
    const controller = new HealthController([{ name: "postgres", check }]);

    await controller.ready(fakeResponse().res);
    await controller.ready(fakeResponse().res);

    expect(check).toHaveBeenCalledTimes(2);
  });
});
