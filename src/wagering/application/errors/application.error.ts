export abstract class ApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidCommandError extends ApplicationError {}

export class WalletNotFoundError extends ApplicationError {}

export class TransactionNotFoundError extends ApplicationError {}

export class WalletAlreadyExistsError extends ApplicationError {}

export class IdempotencyConflictError extends ApplicationError {}

export class UniqueViolationError extends ApplicationError {
  constructor(public readonly constraint: string | undefined) {
    super(`Unique constraint violated: ${constraint ?? "unknown"}`);
  }
}

export class TransientFailureError extends ApplicationError {}
