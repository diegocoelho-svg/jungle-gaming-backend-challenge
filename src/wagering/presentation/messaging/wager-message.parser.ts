import { z } from "zod";
import type { ProcessWagerTransactionCommand } from "../../application/use-cases/process-wager-transaction.use-case";
import { InvalidRequestError, parseSubmitTransaction } from "../http/request-parsers";

export const WAGER_MESSAGE_TYPE = "WagerTransactionRequested";

const SAFE_MESSAGE_ID = /^[\w:.-]{1,128}$/;

export interface WagerMessage {
  messageId: string;
  correlationId?: string;
  command: ProcessWagerTransactionCommand;
}

const envelopeSchema = z.object(
  {
    messageId: z.string({ error: "messageId is required" }).regex(SAFE_MESSAGE_ID, {
      error: "messageId must be a string of up to 128 letters, digits, '_', ':', '.' or '-'",
    }),
    type: z.literal(WAGER_MESSAGE_TYPE, { error: `type must be ${WAGER_MESSAGE_TYPE}` }),
    correlationId: z
      .string({ error: "correlationId must be a safe identifier" })
      .regex(SAFE_MESSAGE_ID, { error: "correlationId must be a safe identifier" })
      .optional(),
    data: z.record(z.string(), z.unknown(), { error: "data must be a JSON object" }),
  },
  { error: "message must be a JSON object" },
);

export function parseWagerMessage(body: string | undefined): WagerMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(body ?? "");
  } catch {
    throw new InvalidRequestError(["message body must be JSON"]);
  }

  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success) {
    throw new InvalidRequestError([...new Set(envelope.error.issues.map((issue) => issue.message))]);
  }

  const { messageId, correlationId, data } = envelope.data;
  const idempotencyKey = typeof data.idempotencyKey === "string" ? data.idempotencyKey : undefined;

  return {
    messageId,
    ...(correlationId !== undefined && { correlationId }),
    command: parseSubmitTransaction(data, idempotencyKey),
  };
}
