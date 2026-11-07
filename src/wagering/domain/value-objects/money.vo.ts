import { CurrencyMismatchError, InvalidMoneyError, MoneyOutOfRangeError } from "../errors/domain.error";

export interface MoneyProps {
  amount: string;
  currency: string;
}

const UNSIGNED_AMOUNT = /^(0|[1-9]\d*)\.\d{2}$/;
const SIGNED_AMOUNT = /^-?(0|[1-9]\d*)\.\d{2}$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const MAX_ABSOLUTE_CENTS = 99_999_999_999_999_999_999n;

const centsFromValidatedAmount = (amount: string): bigint => BigInt(amount.replace(".", ""));

export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {}

  static from({ amount, currency }: MoneyProps): Money {
    if (typeof amount !== "string" || !UNSIGNED_AMOUNT.test(amount)) {
      throw new InvalidMoneyError("Amount must be a non-negative decimal string with 2 places");
    }
    return Money.of(centsFromValidatedAmount(amount), currency);
  }

  static rehydrate({ amount, currency }: MoneyProps): Money {
    if (typeof amount !== "string" || !SIGNED_AMOUNT.test(amount)) {
      throw new InvalidMoneyError("Persisted amount must be a decimal string with 2 places");
    }
    return Money.of(centsFromValidatedAmount(amount), currency);
  }

  static zero(currency: string): Money {
    return Money.of(0n, currency);
  }

  private static of(cents: bigint, currency: string): Money {
    if (typeof currency !== "string" || !CURRENCY_CODE.test(currency)) {
      throw new InvalidMoneyError("Currency must be an ISO-4217 code");
    }
    if (cents > MAX_ABSOLUTE_CENTS || cents < -MAX_ABSOLUTE_CENTS) {
      throw new MoneyOutOfRangeError("Amount out of the supported range");
    }
    return new Money(cents, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return Money.of(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    return { amount: this.formatAmount(), currency: this.currency };
  }

  toString(): string {
    return `${this.formatAmount()} ${this.currency}`;
  }

  private formatAmount(): string {
    const absolute = this.cents < 0n ? -this.cents : this.cents;
    const sign = this.cents < 0n ? "-" : "";
    const fraction = (absolute % 100n).toString().padStart(2, "0");
    return `${sign}${absolute / 100n}.${fraction}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError("Operation between different currencies");
    }
  }
}
