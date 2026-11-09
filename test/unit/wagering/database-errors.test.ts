import { describe, expect, test } from "bun:test";
import {
  isLockConflict,
  isTransientDatabaseFailure,
  isUniqueViolation,
} from "../../../src/wagering/infrastructure/persistence/database-errors";

describe("database error classification", () => {
  test.each([
    ["host name not resolvable while the database is down", { message: "getaddrinfo ENOTFOUND postgres" }],
    ["temporary name resolution failure", { message: "getaddrinfo EAI_AGAIN postgres" }],
    ["connection refused", { message: "connect ECONNREFUSED 172.18.0.2:5432" }],
    ["connection reset", { message: "read ECONNRESET" }],
    ["connection terminated", { message: "Connection terminated unexpectedly" }],
    ["pool connect timeout", { message: "timeout exceeded when trying to connect" }],
    ["admin shutdown", { code: "57P01" }],
    ["connection exception class", { code: "08006" }],
    ["too many connections", { code: "53300" }],
    ["sql state on the cause", { message: "driver error", cause: { code: "40001" } }],
  ])("%s is transient", (_name, error) => {
    expect(isTransientDatabaseFailure(error)).toBe(true);
  });

  test.each([
    ["unique violation", { code: "23505" }],
    ["check violation", { code: "23514" }],
    ["syntax error", { code: "42601", message: "syntax error at or near" }],
    ["unknown error", new Error("boom")],
    ["null", null],
  ])("%s is not transient", (_name, error) => {
    expect(isTransientDatabaseFailure(error)).toBe(false);
  });

  test("unique violations and lock conflicts are recognised by sql state", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ code: "23514" })).toBe(false);
    expect(isLockConflict({ code: "55P03" })).toBe(true);
    expect(isLockConflict({ cause: { code: "40P01" } })).toBe(true);
    expect(isLockConflict({ code: "57014" })).toBe(false);
  });
});
