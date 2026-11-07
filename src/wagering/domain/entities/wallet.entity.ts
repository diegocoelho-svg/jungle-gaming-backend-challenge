import { CurrencyMismatchError, InvalidWalletError, MoneyOutOfRangeError } from "../errors/domain.error";
import type { Money } from "../value-objects/money.vo";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry.entity";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
}

export interface BalanceMovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export enum BalanceMovementFailure {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  LimitExceeded = "LIMIT_EXCEEDED",
}

export type BalanceMovement =
  { applied: true; entry: WalletLedgerEntry } | { applied: false; failure: BalanceMovementFailure };

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open({ id, playerId, initialBalance, at }: OpenWalletProps): Wallet {
    if (initialBalance.isNegative()) {
      throw new InvalidWalletError("Initial balance cannot be negative");
    }
    return new Wallet(id, playerId, initialBalance.currency, initialBalance, 1, at, at);
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit({ entryId, transactionId, money, at }: BalanceMovementProps): BalanceMovement {
    this.assertMovable(money);

    if (this._balance.isLessThan(money)) {
      return { applied: false, failure: BalanceMovementFailure.InsufficientFunds };
    }

    return {
      applied: true,
      entry: this.apply(LedgerDirection.Debit, this._balance.subtract(money), { entryId, transactionId, money, at }),
    };
  }

  credit({ entryId, transactionId, money, at }: BalanceMovementProps): BalanceMovement {
    this.assertMovable(money);

    let balanceAfter: Money;
    try {
      balanceAfter = this._balance.add(money);
    } catch (error) {
      if (error instanceof MoneyOutOfRangeError) {
        return { applied: false, failure: BalanceMovementFailure.LimitExceeded };
      }
      throw error;
    }

    return {
      applied: true,
      entry: this.apply(LedgerDirection.Credit, balanceAfter, { entryId, transactionId, money, at }),
    };
  }

  private apply(
    direction: LedgerDirection,
    balanceAfter: Money,
    { entryId, transactionId, money, at }: BalanceMovementProps,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: this._balance,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: at,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;

    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidWalletError("Balance movement requires a positive amount");
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError("Operation currency differs from the wallet currency");
    }
  }
}
