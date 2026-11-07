import { describe, expect, test } from "bun:test";
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  MoneyOutOfRangeError,
} from "../../../src/wagering/domain/errors/domain.error";
import { Money } from "../../../src/wagering/domain/value-objects/money.vo";
import { brl } from "./fixtures";

const usd = (amount: string) => Money.from({ amount, currency: "USD" });

describe("Money.from", () => {
  test.each(["0.00", "0.01", "25.00", "1000.50", "999999999999999999.99"])("accepts %s", (amount) => {
    expect(brl(amount).toJSON()).toEqual({ amount, currency: "BRL" });
  });

  test.each([
    ["empty", ""],
    ["spaces", "   "],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["scientific notation", "1e3"],
    ["hexadecimal", "0x10"],
    ["negative", "-5.00"],
    ["plus sign", "+5.00"],
    ["no decimals", "25"],
    ["one decimal", "25.5"],
    ["three decimals", "25.001"],
    ["leading zero", "00025.00"],
    ["surrounding spaces", " 25.00 "],
    ["line break", "25.00\n"],
    ["comma", "25,00"],
    ["non-ASCII digit", "٣.00"],
  ])("rejects invalid input: %s", (_, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test("never rounds: extra decimal places are rejected", () => {
    expect(() => brl("1.005")).toThrow(InvalidMoneyError);
    expect(() => brl("1.004")).toThrow(InvalidMoneyError);
  });

  test("rejects an amount that is not a string", () => {
    expect(() => Money.from({ amount: 25 as never, currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test.each(["", "brl", "BR", "BRLL", "R$"])("rejects currency %s", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
  });

  test("rejects amounts above the NUMERIC(20,2) column", () => {
    expect(() => brl("1000000000000000000.00")).toThrow(MoneyOutOfRangeError);
  });
});

describe("Money.rehydrate", () => {
  test("accepts negatives, used for internal differences", () => {
    expect(Money.rehydrate({ amount: "-0.05", currency: "BRL" }).isNegative()).toBe(true);
  });

  test("still rejects an invalid format", () => {
    expect(() => Money.rehydrate({ amount: "1e3", currency: "BRL" })).toThrow(InvalidMoneyError);
  });
});

describe("operations", () => {
  test("adds without floating point error", () => {
    expect(brl("0.10").add(brl("0.20")).toJSON().amount).toBe("0.30");
    expect(brl("0.01").add(brl("0.02")).toJSON().amount).toBe("0.03");
  });

  test("subtracts and may go negative", () => {
    expect(brl("1.00").subtract(brl("1.05")).toJSON().amount).toBe("-0.05");
  });

  test("negates both ways", () => {
    expect(brl("0.05").negate().toJSON().amount).toBe("-0.05");
    expect(brl("0.05").negate().negate().equals(brl("0.05"))).toBe(true);
    expect(brl("0.00").negate().toJSON().amount).toBe("0.00");
  });

  test("is immutable", () => {
    const original = brl("10.00");

    original.add(brl("5.00"));
    original.subtract(brl("5.00"));
    original.negate();

    expect(original.toJSON().amount).toBe("10.00");
  });

  test("addition above the limit throws a range error", () => {
    expect(() => brl("999999999999999999.99").add(brl("0.01"))).toThrow(MoneyOutOfRangeError);
  });

  test("queries", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("0.00").isPositive()).toBe(false);
    expect(brl("0.00").isNegative()).toBe(false);
    expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
    expect(brl("1.01").isLessThan(brl("1.00"))).toBe(false);
    expect(brl("1.00").equals(brl("1.00"))).toBe(true);
  });

  test("serializes with a fixed scale", () => {
    expect(JSON.stringify(brl("5.00"))).toBe('{"amount":"5.00","currency":"BRL"}');
    expect(brl("1234.05").toString()).toBe("1234.05 BRL");
  });
});

describe("currency conflict", () => {
  test.each<[string, (a: Money, b: Money) => unknown]>([
    ["add", (a, b) => a.add(b)],
    ["subtract", (a, b) => a.subtract(b)],
    ["isLessThan", (a, b) => a.isLessThan(b)],
  ])("%s throws a domain error", (_, operation) => {
    expect(() => operation(brl("1.00"), usd("1.00"))).toThrow(CurrencyMismatchError);
  });

  test("equals considers the currency", () => {
    expect(brl("1.00").equals(usd("1.00"))).toBe(false);
  });
});
