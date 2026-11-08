export const APP_ROLES = ["api", "consumer", "workers"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export interface Env {
  appRole: AppRole;
  port: number;
  logLevel: string;
  databaseUrl: string;
  dbPoolMax: number;
  aws: {
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  sqs: {
    endpoint: string;
    wagerQueue: string;
    wagerDlq: string;
    eventsQueue: string;
    maxReceiveCount: number;
    visibilityHeartbeatMs: number;
  };
}

export class InvalidEnvError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`Invalid configuration: ${problems.join("; ")}`);
    this.name = "InvalidEnvError";
  }
}

export const QUEUE_VISIBILITY_TIMEOUT_MS = 30_000;
export const SQS_REQUEST_TIMEOUT_MS = 5_000;
export const MIN_VISIBILITY_HEARTBEAT_MS = 100;
export const MAX_VISIBILITY_HEARTBEAT_MS = QUEUE_VISIBILITY_TIMEOUT_MS - 2 * SQS_REQUEST_TIMEOUT_MS;

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const problems: string[] = [];

  const required = (name: string): string => {
    const value = source[name];
    if (!value) {
      problems.push(`${name} is required`);
      return "";
    }
    return value;
  };

  const positiveInt = (name: string, fallback: number): number => {
    const raw = source[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      problems.push(`${name} must be a positive integer`);
      return fallback;
    }
    return value;
  };

  const appRole = source.APP_ROLE ?? "api";
  if (!APP_ROLES.includes(appRole as AppRole)) {
    problems.push(`APP_ROLE must be one of: ${APP_ROLES.join(", ")}`);
  }

  const logLevel = source.LOG_LEVEL ?? "info";
  if (!LOG_LEVELS.includes(logLevel)) {
    problems.push(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(", ")}`);
  }

  const env: Env = {
    appRole: appRole as AppRole,
    port: positiveInt("PORT", 3000),
    logLevel,
    databaseUrl: required("DATABASE_URL"),
    dbPoolMax: positiveInt("DB_POOL_MAX", 10),
    aws: {
      region: required("AWS_REGION"),
      accessKeyId: required("AWS_ACCESS_KEY_ID"),
      secretAccessKey: required("AWS_SECRET_ACCESS_KEY"),
    },
    sqs: {
      endpoint: required("SQS_ENDPOINT"),
      wagerQueue: required("SQS_WAGER_QUEUE"),
      wagerDlq: required("SQS_WAGER_DLQ"),
      eventsQueue: required("SQS_EVENTS_QUEUE"),
      maxReceiveCount: positiveInt("SQS_MAX_RECEIVE_COUNT", 5),
      visibilityHeartbeatMs: positiveInt("SQS_VISIBILITY_HEARTBEAT_MS", 10_000),
    },
  };

  const heartbeat = env.sqs.visibilityHeartbeatMs;
  if (heartbeat < MIN_VISIBILITY_HEARTBEAT_MS || heartbeat > MAX_VISIBILITY_HEARTBEAT_MS) {
    problems.push(
      `SQS_VISIBILITY_HEARTBEAT_MS must be between ${MIN_VISIBILITY_HEARTBEAT_MS} and ${MAX_VISIBILITY_HEARTBEAT_MS} ms, leaving room for the SQS call before the ${QUEUE_VISIBILITY_TIMEOUT_MS} ms visibility timeout`,
    );
  }

  if (problems.length > 0) throw new InvalidEnvError(problems);
  return env;
}
