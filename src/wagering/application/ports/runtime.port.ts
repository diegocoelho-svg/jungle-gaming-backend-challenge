export const CLOCK = Symbol("CLOCK");
export const ID_GENERATOR = Symbol("ID_GENERATOR");
export const APPLICATION_LOGGER = Symbol("APPLICATION_LOGGER");

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface ApplicationLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}
