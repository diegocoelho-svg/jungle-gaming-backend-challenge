import type { ProcessWagerTransactionCommand } from "../../application/use-cases/process-wager-transaction.use-case";
import { InvalidRequestError, parseSubmitTransaction } from "../http/request-parsers";

export const WAGER_MESSAGE_TYPE = "WagerTransactionRequested";

const SAFE_MESSAGE_ID = /^[\w:.-]{1,128}$/;

export interface WagerMessage {
  messageId: string;
  correlationId?: string;
  command: ProcessWagerTransactionCommand;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseWagerMessage(body: string | undefined): WagerMessage {
  let envelope: unknown;
  try {
    envelope = JSON.parse(body ?? "");
  } catch {
    throw new InvalidRequestError(["message body must be JSON"]);
  }

  if (!isRecord(envelope)) throw new InvalidRequestError(["message must be a JSON object"]);

  const problems: string[] = [];
  const { messageId, type, correlationId, data } = envelope;

  if (typeof messageId !== "string" || !SAFE_MESSAGE_ID.test(messageId)) {
    problems.push("messageId must be a string of up to 128 letters, digits, '_', ':', '.' or '-'");
  }
  if (type !== WAGER_MESSAGE_TYPE) problems.push(`type must be ${WAGER_MESSAGE_TYPE}`);
  if (correlationId !== undefined && (typeof correlationId !== "string" || !SAFE_MESSAGE_ID.test(correlationId))) {
    problems.push("correlationId must be a safe identifier");
  }
  if (!isRecord(data)) problems.push("data must be a JSON object");
  if (problems.length > 0) throw new InvalidRequestError(problems);

  const record = data as Record<string, unknown>;
  const idempotencyKey = typeof record.idempotencyKey === "string" ? record.idempotencyKey : undefined;

  return {
    messageId: messageId as string,
    ...(typeof correlationId === "string" && { correlationId }),
    command: parseSubmitTransaction(record, idempotencyKey),
  };
}
