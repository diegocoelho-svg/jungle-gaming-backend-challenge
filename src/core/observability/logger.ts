import { format } from "node:util";
import type { LoggerService } from "@nestjs/common";
import pino, { type DestinationStream, type Logger } from "pino";
import { currentRequestContext } from "./request-context";

export type { Logger };

const SAFE_IDENTIFIER = /^[\w:.-]{1,128}$/;

const isSafeIdentifier = (value: unknown): boolean => typeof value === "string" && SAFE_IDENTIFIER.test(value);
const isStackTrace = (value: unknown): value is string => typeof value === "string" && /\n\s+at /.test(value);

const maskDecimals = (text: string): string => text.replace(/\d+\.\d+/g, "[REDACTED]");

const LOGGABLE_FIELDS: Record<string, (value: unknown) => boolean> = {
  correlationId: isSafeIdentifier,
  messageId: isSafeIdentifier,
  transactionId: isSafeIdentifier,
  walletId: isSafeIdentifier,
  providerId: isSafeIdentifier,
  context: isSafeIdentifier,
  stack: isStackTrace,
  port: Number.isInteger,
};

function keepLoggableFields(fields: Record<string, unknown>): Record<string, unknown> {
  const kept = Object.fromEntries(Object.entries(fields).filter(([field, value]) => LOGGABLE_FIELDS[field]?.(value)));

  if (typeof kept.stack === "string") kept.stack = maskDecimals(kept.stack);

  if (fields.err instanceof Error) {
    const { name, message, stack, cause } = fields.err;
    kept.err = {
      type: name,
      message: maskDecimals(message),
      stack: stack && maskDecimals(stack),
      ...(cause instanceof Error && { cause: { type: cause.name, message: maskDecimals(cause.message) } }),
    };
  }

  return kept;
}

const errorIn = (value: unknown): Error | undefined => {
  if (value instanceof Error) return value;
  const nested = (value as { err?: unknown } | null | undefined)?.err;
  return nested instanceof Error ? nested : undefined;
};

function sanitizeLogArguments(args: unknown[]): unknown[] {
  const [first, ...rest] = args;
  const hasFields = typeof first !== "string";
  const messageParts = (hasFields ? rest : args).filter((part) => part !== undefined);
  const message = messageParts.length > 0 ? format(...messageParts) : errorIn(first)?.message;
  const masked = message === undefined ? [] : [maskDecimals(message)];

  if (!hasFields) return masked;
  return [first instanceof Error ? { err: first } : first, ...masked];
}

export function createLogger(options: { level: string; role: string }, destination?: DestinationStream): Logger {
  return pino(
    {
      level: options.level,
      base: { service: "wagering-processor", role: options.role },
      timestamp: pino.stdTimeFunctions.isoTime,
      mixin: () => ({ ...currentRequestContext() }),
      formatters: { log: keepLoggableFields },
      hooks: {
        logMethod(args, method) {
          method.apply(this, sanitizeLogArguments(args) as Parameters<typeof method>);
        },
      },
      serializers: { err: (error: unknown) => error },
    },
    destination,
  );
}

export class NestLoggerAdapter implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write("info", message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.write("error", message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write("warn", message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write("debug", message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write("trace", message, params);
  }

  private write(level: "info" | "error" | "warn" | "debug" | "trace", message: unknown, params: unknown[]): void {
    const stack = params.find(isStackTrace);
    const context = params.findLast((param) => typeof param === "string" && param !== stack);

    this.logger[level]({ context, stack }, String(message));
  }
}
