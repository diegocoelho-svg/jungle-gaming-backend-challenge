import { LedgerDirection, type WalletLedgerEntry } from "../entities/wallet-ledger-entry.entity";
import { BalanceMovementFailure, type Wallet } from "../entities/wallet.entity";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransaction,
} from "../entities/wager-transaction.entity";
import { InvalidTransactionError, InvalidTransactionStateError } from "../errors/domain.error";
import { FailureCode } from "../errors/failure-code";

export interface SettlementInput {
  transaction: WagerTransaction;
  wallet: Wallet;
  reference?: WagerTransaction;
  referenceAlreadyReversed: boolean;
  ledgerEntryId: string;
  at: Date;
}

export interface SettlementResult {
  entry?: WalletLedgerEntry;
}

const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

const AWAIT_REFERENCE = "AWAIT_REFERENCE";
const REFERENCE_READY = "REFERENCE_READY";

type ReferenceCheck = typeof AWAIT_REFERENCE | typeof REFERENCE_READY | FailureCode;

function isDeclaredReference(transaction: WagerTransaction, reference: WagerTransaction): boolean {
  return (
    transaction.referenceExternalTransactionId === reference.externalTransactionId &&
    transaction.providerId === reference.providerId &&
    transaction.playerId === reference.playerId &&
    transaction.walletId === reference.walletId &&
    transaction.roundId === reference.roundId &&
    transaction.money.currency === reference.money.currency
  );
}

function checkReference({ transaction, reference, referenceAlreadyReversed }: SettlementInput): ReferenceCheck {
  if (!transaction.referenceExternalTransactionId) return REFERENCE_READY;
  if (!reference) return AWAIT_REFERENCE;
  if (!isDeclaredReference(transaction, reference)) return FailureCode.ReferenceMismatch;
  if (!ALLOWED_REFERENCE_KINDS[transaction.kind]?.includes(reference.kind)) return FailureCode.ReferenceInvalidKind;
  if (reference.isAwaitingSettlement()) return AWAIT_REFERENCE;
  if (reference.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;

  if (transaction.requiresReference()) {
    if (!transaction.money.equals(reference.money)) return FailureCode.ReferenceAmountMismatch;
    if (referenceAlreadyReversed) return FailureCode.ReferenceAlreadyReversed;
  }

  return REFERENCE_READY;
}

function awaitReference({ transaction, wallet, reference, at }: SettlementInput): void {
  if (transaction.status === WagerTransactionStatus.Pending) {
    transaction.markPendingReference(at);
  } else if (transaction.hasExhaustedReferenceAttempts()) {
    transaction.reject(reference ? FailureCode.ReferenceNotProcessed : FailureCode.ReferenceNotFound, wallet.balance);
  } else {
    transaction.scheduleReferenceRetry(at);
  }
}

function failureCodeFor(
  failure: BalanceMovementFailure,
  transaction: WagerTransaction,
  direction: LedgerDirection,
): FailureCode {
  if (failure === BalanceMovementFailure.LimitExceeded) return FailureCode.BalanceLimitExceeded;

  return direction === LedgerDirection.Debit && transaction.kind === WagerTransactionKind.Rollback
    ? FailureCode.ReversalInsufficientFunds
    : FailureCode.InsufficientFunds;
}

function applyToBalance({ transaction, wallet, reference, ledgerEntryId, at }: SettlementInput): SettlementResult {
  const direction = transaction.ledgerDirectionFor(reference);
  const movementProps = { entryId: ledgerEntryId, transactionId: transaction.id, money: transaction.money, at };
  const movement = direction === LedgerDirection.Debit ? wallet.debit(movementProps) : wallet.credit(movementProps);

  if (!movement.applied) {
    transaction.reject(failureCodeFor(movement.failure, transaction, direction), wallet.balance);
    return {};
  }

  transaction.markProcessed(reference?.id, at, wallet.balance);
  return { entry: movement.entry };
}

export function settleTransaction(input: SettlementInput): SettlementResult {
  const { transaction, wallet, reference, at } = input;

  if (transaction.isTerminal()) {
    throw new InvalidTransactionStateError(`Transaction ${transaction.status} cannot be settled`);
  }
  if (transaction.walletId !== wallet.id) {
    throw new InvalidTransactionError("Transaction does not belong to the given wallet");
  }
  if (reference && !transaction.referenceExternalTransactionId) {
    throw new InvalidTransactionError("Transaction without a declared reference received one");
  }
  if (transaction.playerId !== wallet.playerId) {
    transaction.reject(FailureCode.PlayerWalletMismatch, wallet.balance);
    return {};
  }
  if (transaction.money.currency !== wallet.currency) {
    transaction.reject(FailureCode.CurrencyMismatch, wallet.balance);
    return {};
  }

  const referenceCheck = checkReference(input);

  if (referenceCheck === AWAIT_REFERENCE) {
    awaitReference(input);
    return {};
  }
  if (referenceCheck !== REFERENCE_READY) {
    transaction.reject(referenceCheck, wallet.balance);
    return {};
  }

  if (!transaction.affectsBalance()) {
    transaction.markProcessed(reference?.id, at, wallet.balance);
    return {};
  }

  return applyToBalance(input);
}
