const TRANSIENT_SQL_STATES = new Set(["55P03", "40001", "40P01", "57014", "57P01", "57P02", "57P03", "53300"]);
const TRANSIENT_MESSAGES = [
  "timeout exceeded when trying to connect",
  "Connection terminated",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "Query read timeout",
];

interface DriverErrorShape {
  code?: unknown;
  sqlState?: unknown;
  constraint?: unknown;
  message?: unknown;
  cause?: DriverErrorShape;
}

const shapeOf = (error: unknown): DriverErrorShape => (error ?? {}) as DriverErrorShape;

function sqlStateOf(error: unknown): string | undefined {
  const shape = shapeOf(error);
  const state = shape.code ?? shape.sqlState ?? shape.cause?.code;
  return typeof state === "string" ? state : undefined;
}

export function constraintOf(error: unknown): string | undefined {
  const shape = shapeOf(error);
  const constraint = shape.constraint ?? shape.cause?.constraint;
  if (typeof constraint === "string") return constraint;

  const message = typeof shape.message === "string" ? shape.message : "";
  return /constraint "([^"]+)"/.exec(message)?.[1];
}

export function isUniqueViolation(error: unknown): boolean {
  return sqlStateOf(error) === "23505";
}

const LOCK_CONFLICT_SQL_STATES = new Set(["55P03", "40P01"]);

export function isLockConflict(error: unknown): boolean {
  const state = sqlStateOf(error);
  return state !== undefined && LOCK_CONFLICT_SQL_STATES.has(state);
}

export function isTransientDatabaseFailure(error: unknown): boolean {
  const state = sqlStateOf(error);
  if (state && (TRANSIENT_SQL_STATES.has(state) || state.startsWith("08"))) return true;

  const message = String(shapeOf(error).message ?? "");
  return TRANSIENT_MESSAGES.some((fragment) => message.includes(fragment));
}
