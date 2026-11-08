import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Inject } from "@nestjs/common";
import type { Response } from "express";
import { LOGGER } from "../../../core/core.module";
import type { Logger } from "../../../core/observability/logger";
import {
  IdempotencyConflictError,
  InvalidCommandError,
  TransactionNotFoundError,
  TransientFailureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../application/errors/application.error";
import { DomainError } from "../../domain/errors/domain.error";
import { InvalidRequestError } from "./request-parsers";

interface ErrorReply {
  status: HttpStatus;
  error: string;
  message: string;
  details?: string[];
}

const RETRY_AFTER_SECONDS = "1";

function replyFor(exception: unknown): ErrorReply | undefined {
  if (exception instanceof InvalidRequestError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      error: "INVALID_REQUEST",
      message: "Invalid request",
      details: exception.problems,
    };
  }
  if (exception instanceof InvalidCommandError || exception instanceof DomainError) {
    return { status: HttpStatus.BAD_REQUEST, error: "INVALID_REQUEST", message: exception.message };
  }
  if (exception instanceof WalletNotFoundError) {
    return { status: HttpStatus.NOT_FOUND, error: "WALLET_NOT_FOUND", message: exception.message };
  }
  if (exception instanceof TransactionNotFoundError) {
    return { status: HttpStatus.NOT_FOUND, error: "TRANSACTION_NOT_FOUND", message: exception.message };
  }
  if (exception instanceof IdempotencyConflictError) {
    return { status: HttpStatus.CONFLICT, error: "IDEMPOTENCY_CONFLICT", message: exception.message };
  }
  if (exception instanceof WalletAlreadyExistsError) {
    return { status: HttpStatus.CONFLICT, error: "WALLET_ALREADY_EXISTS", message: exception.message };
  }
  if (exception instanceof TransientFailureError) {
    return { status: HttpStatus.SERVICE_UNAVAILABLE, error: "TEMPORARILY_UNAVAILABLE", message: exception.message };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return {
      status,
      error: status === HttpStatus.NOT_FOUND ? "NOT_FOUND" : "INVALID_REQUEST",
      message: exception.message,
    };
  }
  return undefined;
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const reply = replyFor(exception);

    if (!reply) {
      this.logger.error({ err: exception }, "unhandled request error");
      response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: "INTERNAL_ERROR", message: "Internal error" });
      return;
    }

    if (reply.status === HttpStatus.SERVICE_UNAVAILABLE) {
      response.setHeader("Retry-After", RETRY_AFTER_SECONDS);
    }

    const { status, ...body } = reply;
    response.status(status).json(body);
  }
}
