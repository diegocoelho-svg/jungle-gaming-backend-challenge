import { z } from "zod";
import type { OpenWalletCommand } from "../../application/use-cases/open-wallet.use-case";
import type { ProcessWagerTransactionCommand } from "../../application/use-cases/process-wager-transaction.use-case";
import { WagerTransactionKind } from "../../domain/entities/wager-transaction.entity";

export class InvalidRequestError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid request: ${problems.join("; ")}`);
    this.name = "InvalidRequestError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBMITTABLE_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;
const MAX_TEXT_LENGTH = 255;
const CONTROL_CHARACTERS = /\p{Cc}/u;
const DEFAULT_LEDGER_LIMIT = 50;
const MAX_LEDGER_LIMIT = 200;
const CURSOR_PREFIX = "v1:";

export const isUuid = (value: string): boolean => UUID.test(value);

export const isIdentifier = (value: string): boolean =>
  value.length > 0 && value.length <= MAX_TEXT_LENGTH && !CONTROL_CHARACTERS.test(value);

const text = (field: string) => {
  const error = `${field} must be a non-empty string up to ${MAX_TEXT_LENGTH} characters`;
  return z
    .string({ error })
    .min(1, { error, abort: true })
    .max(MAX_TEXT_LENGTH, { error, abort: true })
    .refine((value) => !CONTROL_CHARACTERS.test(value), { error: `${field} must not contain control characters` });
};

const money = (field: string) => {
  const error = `${field} must be an object with string amount and currency`;
  return z.object({ amount: z.string({ error }), currency: z.string({ error }) }, { error });
};

const openWalletSchema = z.object({
  playerId: text("playerId"),
  initialBalance: money("initialBalance"),
});

const submitTransactionSchema = z.object({
  providerId: text("providerId"),
  externalTransactionId: text("externalTransactionId"),
  playerId: text("playerId"),
  walletId: text("walletId").refine(isUuid, { error: "walletId must be a UUID" }),
  roundId: text("roundId"),
  gameId: text("gameId"),
  kind: z.enum(SUBMITTABLE_KINDS, { error: `kind must be one of ${SUBMITTABLE_KINDS.join(", ")}` }),
  money: money("money"),
  referenceExternalTransactionId: text("referenceExternalTransactionId").optional(),
});

const idempotencyKeySchema = z
  .string({
    error: `Idempotency-Key header is required, up to ${MAX_TEXT_LENGTH} characters, without control characters`,
  })
  .refine(isIdentifier, {
    error: `Idempotency-Key header is required, up to ${MAX_TEXT_LENGTH} characters, without control characters`,
  });

const ledgerQuerySchema = z.object({
  cursor: z
    .string({ error: "cursor is invalid" })
    .transform((cursor, context) => {
      const decoded = Buffer.from(cursor, "base64url").toString("utf8");
      const version = Number(decoded.slice(CURSOR_PREFIX.length));
      if (decoded.startsWith(CURSOR_PREFIX) && Number.isInteger(version) && version >= 0) return version;
      context.addIssue({ code: "custom", message: "cursor is invalid" });
      return z.NEVER;
    })
    .optional(),
  limit: z.coerce
    .number({ error: `limit must be an integer between 1 and ${MAX_LEDGER_LIMIT}` })
    .int({ error: `limit must be an integer between 1 and ${MAX_LEDGER_LIMIT}` })
    .min(1, { error: `limit must be an integer between 1 and ${MAX_LEDGER_LIMIT}` })
    .max(MAX_LEDGER_LIMIT, { error: `limit must be an integer between 1 and ${MAX_LEDGER_LIMIT}` })
    .optional(),
});

const problemsOf = (error: z.ZodError): string[] => [...new Set(error.issues.map((issue) => issue.message))];

function requireObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidRequestError(["body must be a JSON object"]);
  }
  return body as Record<string, unknown>;
}

export function parseOpenWallet(body: unknown): OpenWalletCommand {
  const parsed = openWalletSchema.safeParse(requireObject(body));
  if (!parsed.success) throw new InvalidRequestError(problemsOf(parsed.error));
  return parsed.data;
}

export function parseSubmitTransaction(
  body: unknown,
  idempotencyKey: string | undefined,
): ProcessWagerTransactionCommand {
  const key = idempotencyKeySchema.safeParse(idempotencyKey);
  const parsed = submitTransactionSchema.safeParse(requireObject(body));

  const problems = [...(key.success ? [] : problemsOf(key.error)), ...(parsed.success ? [] : problemsOf(parsed.error))];
  if (!key.success || !parsed.success) throw new InvalidRequestError(problems);

  const { referenceExternalTransactionId, ...command } = parsed.data;
  return {
    ...command,
    idempotencyKey: key.data,
    ...(referenceExternalTransactionId !== undefined && { referenceExternalTransactionId }),
  };
}

export const encodeLedgerCursor = (afterVersion: number): string =>
  Buffer.from(`${CURSOR_PREFIX}${afterVersion}`).toString("base64url");

export function parseLedgerQuery(cursor: unknown, limit: unknown): { afterVersion: number; limit: number } {
  const parsed = ledgerQuerySchema.safeParse({ cursor, limit });
  if (!parsed.success) throw new InvalidRequestError(problemsOf(parsed.error));
  return { afterVersion: parsed.data.cursor ?? 0, limit: parsed.data.limit ?? DEFAULT_LEDGER_LIMIT };
}
