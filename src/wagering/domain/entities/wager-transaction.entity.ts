import { InvalidTransactionError, InvalidTransactionStateError } from "../errors/domain.error";
import type { FailureCode } from "../errors/failure-code";
import { computePayloadHash } from "../services/payload-hash.service";
import type { Money } from "../value-objects/money.vo";
import { LedgerDirection } from "./wallet-ledger-entry.entity";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  resultBalance?: Money;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  at: Date;
}

export const INTERNAL_PROVIDER_ID = "internal";

const TERMINAL_STATUSES = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

const REFERENCE_RETRY_BASE_MS = 5_000;
const REFERENCE_RETRY_MAX_MS = 300_000;
const MAX_REFERENCE_ATTEMPTS = 12;

const referenceRetryDelay = (attempts: number): number =>
  Math.min(REFERENCE_RETRY_BASE_MS * 2 ** attempts, REFERENCE_RETRY_MAX_MS);

export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  public readonly referenceExternalTransactionId: string | undefined;
  public readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private _resultBalance: Money | undefined;
  private _referenceAttempts: number;
  private _nextReferenceAttemptAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt;
    this._resultBalance = state.resultBalance;
    this._referenceAttempts = state.referenceAttempts;
    this._nextReferenceAttemptAt = state.nextReferenceAttemptAt;
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidTransactionError("Unknown transaction kind");
    }
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidTransactionError("OPENING is internal and cannot be submitted");
    }
    if (props.referenceExternalTransactionId === "") {
      throw new InvalidTransactionError("referenceExternalTransactionId cannot be empty");
    }

    const transaction = new WagerTransaction({
      ...props,
      status: WagerTransactionStatus.Pending,
      referenceAttempts: 0,
    });

    if (transaction.requiresReference() && !props.referenceExternalTransactionId) {
      throw new InvalidTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (props.kind === WagerTransactionKind.Loss ? props.money.isNegative() : !props.money.isPositive()) {
      throw new InvalidTransactionError(`Invalid amount for ${props.kind}`);
    }

    return transaction;
  }

  static opening({ id, walletId, playerId, money, at }: OpeningTransactionProps): WagerTransaction {
    if (!money.isPositive()) {
      throw new InvalidTransactionError("OPENING requires a positive balance");
    }

    const externalTransactionId = `opening:${walletId}`;

    return new WagerTransaction({
      id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId,
      idempotencyKey: externalTransactionId,
      payloadHash: computePayloadHash({
        providerId: INTERNAL_PROVIDER_ID,
        externalTransactionId,
        playerId,
        walletId,
        roundId: externalTransactionId,
        gameId: externalTransactionId,
        kind: WagerTransactionKind.Opening,
        money: money.toJSON(),
      }),
      walletId,
      playerId,
      roundId: externalTransactionId,
      gameId: externalTransactionId,
      kind: WagerTransactionKind.Opening,
      money,
      createdAt: at,
      status: WagerTransactionStatus.Processed,
      processedAt: at,
      resultBalance: money,
      referenceAttempts: 0,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date, resultBalance: Money): void {
    this.assertStatusIn(WagerTransactionStatus.Pending, WagerTransactionStatus.PendingReference);
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultBalance = resultBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  markPendingReference(at: Date): void {
    this.assertStatusIn(WagerTransactionStatus.Pending);
    this._status = WagerTransactionStatus.PendingReference;
    this.scheduleNextAttempt(at);
  }

  scheduleReferenceRetry(at: Date): void {
    this.assertStatusIn(WagerTransactionStatus.PendingReference);
    this._referenceAttempts += 1;
    this.scheduleNextAttempt(at);
  }

  reject(code: FailureCode, resultBalance: Money): void {
    this.assertStatusIn(WagerTransactionStatus.Pending, WagerTransactionStatus.PendingReference);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._resultBalance = resultBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: FailureCode): void {
    this.assertStatusIn(WagerTransactionStatus.PendingReference);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceAttemptAt = undefined;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  isAwaitingSettlement(): boolean {
    return !this.isTerminal();
  }

  hasExhaustedReferenceAttempts(): boolean {
    return this._referenceAttempts + 1 >= MAX_REFERENCE_ATTEMPTS;
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) throw new InvalidTransactionError("ROLLBACK requires the referenced transaction");
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionError("LOSS creates no ledger entry");
      default:
        throw new InvalidTransactionError("Transaction kind has no ledger direction");
    }
  }

  private scheduleNextAttempt(at: Date): void {
    this._nextReferenceAttemptAt = new Date(at.getTime() + referenceRetryDelay(this._referenceAttempts));
  }

  private assertStatusIn(...allowed: WagerTransactionStatus[]): void {
    if (!allowed.includes(this._status)) {
      throw new InvalidTransactionStateError(`Invalid transition from ${this._status}`);
    }
  }
}
