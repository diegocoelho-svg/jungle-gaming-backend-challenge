import type { OpenWalletCommand } from "../../application/use-cases/open-wallet.use-case";
import type { ProcessWagerTransactionCommand } from "../../application/use-cases/process-wager-transaction.use-case";
import { WagerTransactionKind } from "../../domain/entities/wager-transaction.entity";
import type { MoneyProps } from "../../domain/value-objects/money.vo";

export class InvalidRequestError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid request: ${problems.join("; ")}`);
    this.name = "InvalidRequestError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBMITTABLE_KINDS: string[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];
const MAX_TEXT_LENGTH = 255;
const CONTROL_CHARACTERS = /\p{Cc}/u;
const DEFAULT_LEDGER_LIMIT = 50;
const MAX_LEDGER_LIMIT = 200;

export const isUuid = (value: string): boolean => UUID.test(value);

export const isIdentifier = (value: string): boolean =>
  value.length > 0 && value.length <= MAX_TEXT_LENGTH && !CONTROL_CHARACTERS.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

class FieldReader {
  readonly problems: string[] = [];

  constructor(private readonly body: Record<string, unknown>) {}

  text(field: string): string {
    const value = this.body[field];
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT_LENGTH) {
      this.problems.push(`${field} must be a non-empty string up to ${MAX_TEXT_LENGTH} characters`);
      return "";
    }
    if (CONTROL_CHARACTERS.test(value)) {
      this.problems.push(`${field} must not contain control characters`);
      return "";
    }
    return value;
  }

  optionalText(field: string): string | undefined {
    return this.body[field] === undefined ? undefined : this.text(field);
  }

  uuid(field: string): string {
    const value = this.text(field);
    if (value && !isUuid(value)) this.problems.push(`${field} must be a UUID`);
    return value;
  }

  money(field: string): MoneyProps {
    const value = this.body[field];
    if (!isRecord(value) || typeof value.amount !== "string" || typeof value.currency !== "string") {
      this.problems.push(`${field} must be an object with string amount and currency`);
      return { amount: "", currency: "" };
    }
    return { amount: value.amount, currency: value.currency };
  }

  kind(field: string): WagerTransactionKind {
    const value = this.body[field];
    if (typeof value !== "string" || !SUBMITTABLE_KINDS.includes(value)) {
      this.problems.push(`${field} must be one of ${SUBMITTABLE_KINDS.join(", ")}`);
    }
    return value as WagerTransactionKind;
  }

  done(): void {
    if (this.problems.length > 0) throw new InvalidRequestError(this.problems);
  }
}

function readerFor(body: unknown): FieldReader {
  if (!isRecord(body)) throw new InvalidRequestError(["body must be a JSON object"]);
  return new FieldReader(body);
}

export function parseOpenWallet(body: unknown): OpenWalletCommand {
  const reader = readerFor(body);
  const command = { playerId: reader.text("playerId"), initialBalance: reader.money("initialBalance") };
  reader.done();
  return command;
}

export function parseSubmitTransaction(
  body: unknown,
  idempotencyKey: string | undefined,
): ProcessWagerTransactionCommand {
  const reader = readerFor(body);
  if (!idempotencyKey || idempotencyKey.length > MAX_TEXT_LENGTH || CONTROL_CHARACTERS.test(idempotencyKey)) {
    reader.problems.push(
      `Idempotency-Key header is required, up to ${MAX_TEXT_LENGTH} characters, without control characters`,
    );
  }

  const referenceExternalTransactionId = reader.optionalText("referenceExternalTransactionId");
  const command: ProcessWagerTransactionCommand = {
    providerId: reader.text("providerId"),
    externalTransactionId: reader.text("externalTransactionId"),
    idempotencyKey: idempotencyKey ?? "",
    playerId: reader.text("playerId"),
    walletId: reader.uuid("walletId"),
    roundId: reader.text("roundId"),
    gameId: reader.text("gameId"),
    kind: reader.kind("kind"),
    money: reader.money("money"),
    ...(referenceExternalTransactionId !== undefined && { referenceExternalTransactionId }),
  };

  reader.done();
  return command;
}

const CURSOR_PREFIX = "v1:";

export const encodeLedgerCursor = (afterVersion: number): string =>
  Buffer.from(`${CURSOR_PREFIX}${afterVersion}`).toString("base64url");

export function parseLedgerQuery(cursor: unknown, limit: unknown): { afterVersion: number; limit: number } {
  const problems: string[] = [];
  let afterVersion = 0;
  let pageSize = DEFAULT_LEDGER_LIMIT;

  if (cursor !== undefined) {
    const decoded = typeof cursor === "string" ? Buffer.from(cursor, "base64url").toString("utf8") : "";
    const version = Number(decoded.slice(CURSOR_PREFIX.length));
    if (!decoded.startsWith(CURSOR_PREFIX) || !Number.isInteger(version) || version < 0) {
      problems.push("cursor is invalid");
    } else {
      afterVersion = version;
    }
  }

  if (limit !== undefined) {
    const value = Number(limit);
    if (!Number.isInteger(value) || value < 1 || value > MAX_LEDGER_LIMIT) {
      problems.push(`limit must be an integer between 1 and ${MAX_LEDGER_LIMIT}`);
    } else {
      pageSize = value;
    }
  }

  if (problems.length > 0) throw new InvalidRequestError(problems);
  return { afterVersion, limit: pageSize };
}
