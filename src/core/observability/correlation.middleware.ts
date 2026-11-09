import type { NextFunction, Request, Response } from "express";
import { runWithRequestContext } from "./request-context";

const CORRELATION_HEADER = "x-correlation-id";

const SAFE_CORRELATION_ID = /^[\w-]{1,128}$/;

export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const received = req.header(CORRELATION_HEADER);
  const correlationId = received && SAFE_CORRELATION_ID.test(received) ? received : Bun.randomUUIDv7();

  res.setHeader(CORRELATION_HEADER, correlationId);
  runWithRequestContext({ correlationId }, next);
}
