import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import {
  createTestOrm,
  expectSqlError,
  id,
  inTransaction,
  persistOpenedWallet,
  resetSchema,
} from "../../support/database";

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const RAISED_EXCEPTION = "P0001";
const HASH = "a".repeat(64);

let orm: MikroORM;

type Sql = (query: string, params?: unknown[]) => Promise<unknown>;

interface TransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  wallet_id: string;
  player_id: string;
  kind: string;
  amount: string;
  currency: string;
  status: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  failure_code: string | null;
  result_balance: string | null;
  processed_at: Date | null;
  next_reference_attempt_at: Date | null;
}

async function insertTransaction(
  sql: Sql,
  walletId: string,
  playerId: string,
  overrides: Partial<TransactionRow> = {},
) {
  const externalId = overrides.external_transaction_id ?? id();
  const row: TransactionRow = {
    id: id(),
    provider_id: "provider-a",
    external_transaction_id: externalId,
    idempotency_key: `provider-a:${externalId}`,
    wallet_id: walletId,
    player_id: playerId,
    kind: "BET",
    amount: "10.00",
    currency: "BRL",
    status: "PENDING",
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    failure_code: null,
    result_balance: null,
    processed_at: null,
    next_reference_attempt_at: null,
    ...overrides,
  };

  await sql(
    `insert into wager_transactions (
      id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
      round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
      status, failure_code, result_balance, result_balance_currency, created_at, processed_at, next_reference_attempt_at
    ) values (?, ?, ?, ?, ?, ?, ?, 'round-1', 'game-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, now(), ?, ?)`,
    [
      row.id,
      row.provider_id,
      row.external_transaction_id,
      row.idempotency_key,
      HASH,
      row.wallet_id,
      row.player_id,
      row.kind,
      row.amount,
      row.currency,
      row.reference_external_transaction_id,
      row.reference_transaction_id,
      row.status,
      row.failure_code,
      row.result_balance,
      row.result_balance === null ? null : "BRL",
      row.processed_at,
      row.next_reference_attempt_at,
    ],
  );

  return row;
}

async function aWallet(initialBalance = "100.00") {
  const opened = await persistOpenedWallet(orm, initialBalance);
  return { walletId: opened.wallet.id, playerId: opened.wallet.playerId, opening: opened.opening };
}

const processed = { status: "PROCESSED", result_balance: "90.00", processed_at: new Date() };

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
});

afterAll(async () => {
  await orm.close();
});

describe("migrations", () => {
  const tableExists = async (name: string) => {
    const [row] = await orm.em.getConnection().execute(`select to_regclass('${name}') as found`);
    return row?.found !== null;
  };

  test("down removes every table and up recreates them", async () => {
    await orm.migrator.down();

    for (const table of [
      "wallets",
      "wager_transactions",
      "wallet_ledger_entries",
      "inbox_messages",
      "outbox_messages",
    ]) {
      expect(await tableExists(table)).toBe(false);
    }

    await orm.migrator.up();

    expect(await tableExists("wallet_ledger_entries")).toBe(true);
  });
});

describe("wallets", () => {
  test("allows only one wallet per player and currency", async () => {
    const { playerId } = await aWallet("0.00");

    await expectSqlError(() => persistOpenedWallet(orm, "0.00", playerId), UNIQUE_VIOLATION);
  });

  test("rejects a negative balance", async () => {
    const { walletId } = await aWallet("0.00");

    await expectSqlError(
      () =>
        inTransaction(orm, (sql) =>
          sql("update wallets set balance = -0.01, version = 2 where id = ?", [walletId]).then(() => {}),
        ),
      CHECK_VIOLATION,
    );
  });

  test("rejects an invalid currency", async () => {
    await expectSqlError(
      () =>
        inTransaction(orm, async (sql) => {
          await sql("insert into wallets values (?, 'player', 'brl', 0, 1, now(), now())", [id()]);
        }),
      CHECK_VIOLATION,
    );
  });

  test("refuses to commit a balance change without a ledger entry", async () => {
    const { walletId } = await aWallet("100.00");

    await expectSqlError(
      () =>
        inTransaction(orm, async (sql) => {
          await sql("update wallets set balance = 50, version = 2 where id = ?", [walletId]);
        }),
      RAISED_EXCEPTION,
    );
  });

  test("refuses to commit a version bump without a balance change", async () => {
    const { walletId } = await aWallet("100.00");

    await expectSqlError(
      () =>
        inTransaction(orm, async (sql) => {
          await sql("update wallets set version = version + 1 where id = ?", [walletId]);
        }),
      RAISED_EXCEPTION,
    );
  });

  test("refuses a wallet opened with a balance but no ledger entry", async () => {
    await expectSqlError(
      () =>
        inTransaction(orm, async (sql) => {
          await sql("insert into wallets values (?, ?, 'BRL', 10, 1, now(), now())", [id(), id()]);
        }),
      RAISED_EXCEPTION,
    );
  });

  test("refuses a wallet that does not start at version 1", async () => {
    await expectSqlError(
      () =>
        inTransaction(orm, async (sql) => {
          await sql("insert into wallets values (?, ?, 'BRL', 0, 2, now(), now())", [id(), id()]);
        }),
      RAISED_EXCEPTION,
    );
  });

  test.each([
    ["a balance change that keeps the version", "update wallets set balance = 90 where id = ?"],
    ["a balance change that skips a version", "update wallets set balance = 90, version = 3 where id = ?"],
    ["a version change without a balance change", "update wallets set version = 2 where id = ?"],
    ["a change of owner", "update wallets set player_id = 'someone-else' where id = ?"],
    ["a change of currency", "update wallets set currency = 'USD' where id = ?"],
  ])("refuses %s immediately", async (_, query) => {
    const { walletId } = await aWallet("100.00");

    await expectSqlError(() => inTransaction(orm, (sql) => sql(query, [walletId]).then(() => {})), RAISED_EXCEPTION);
  });

  test("refuses a wallet created at version 2 together with a matching entry", async () => {
    await expectSqlError(
      () =>
        inTransaction(orm, async (sql) => {
          const walletId = id();
          const playerId = id();
          await sql("insert into wallets values (?, ?, 'BRL', 10, 2, now(), now())", [walletId, playerId]);
          const win = await insertTransaction(sql, walletId, playerId, { ...processed, kind: "WIN" });
          await sql(
            `insert into wallet_ledger_entries
               (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
             values (?, ?, ?, 'CREDIT', 10, 'BRL', 0, 10, 2, now())`,
            [id(), walletId, win.id],
          );
        }),
      RAISED_EXCEPTION,
    );
  });

  test("refuses a first credit at version 1 on an existing empty wallet", async () => {
    const { walletId, playerId } = await aWallet("0.00");

    await expectSqlError(
      () =>
        inTransaction(orm, async (sql) => {
          const win = await insertTransaction(sql, walletId, playerId, { ...processed, kind: "WIN" });
          await sql(
            `insert into wallet_ledger_entries
               (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
             values (?, ?, ?, 'CREDIT', 10, 'BRL', 0, 10, 1, now())`,
            [id(), walletId, win.id],
          );
          await sql("update wallets set balance = 10 where id = ?", [walletId]);
        }),
      RAISED_EXCEPTION,
    );
  });
});

describe("wager_transactions", () => {
  test("allows each idempotency key once per provider", async () => {
    const { walletId, playerId } = await aWallet();

    await inTransaction(orm, async (sql) => {
      await insertTransaction(sql, walletId, playerId, { idempotency_key: "key-1" });
      await insertTransaction(sql, walletId, playerId, { idempotency_key: "key-1", provider_id: "provider-b" });
    });

    await expectSqlError(
      () =>
        inTransaction(orm, (sql) =>
          insertTransaction(sql, walletId, playerId, { idempotency_key: "key-1" }).then(() => {}),
        ),
      UNIQUE_VIOLATION,
    );
  });

  test("allows each external transaction id once per provider", async () => {
    const { walletId, playerId } = await aWallet();
    const externalId = id();

    await inTransaction(orm, (sql) =>
      insertTransaction(sql, walletId, playerId, { external_transaction_id: externalId }).then(() => {}),
    );

    await expectSqlError(
      () =>
        inTransaction(orm, (sql) =>
          insertTransaction(sql, walletId, playerId, {
            external_transaction_id: externalId,
            idempotency_key: "other-key",
          }).then(() => {}),
        ),
      UNIQUE_VIOLATION,
    );
  });

  test.each<[string, Partial<TransactionRow>]>([
    ["REFUND without a reference", { kind: "REFUND" }],
    ["ROLLBACK without a reference", { kind: "ROLLBACK" }],
    ["REJECTED without a failure code", { status: "REJECTED", result_balance: "1.00" }],
    ["a failure code on a pending transaction", { failure_code: "INSUFFICIENT_FUNDS" }],
    ["PROCESSED without a result balance", { status: "PROCESSED", processed_at: new Date() }],
    ["PROCESSED without a timestamp", { status: "PROCESSED", result_balance: "1.00" }],
    ["PENDING_REFERENCE without a schedule", { status: "PENDING_REFERENCE" }],
    ["a zero BET", { amount: "0.00" }],
    ["a negative amount", { amount: "-1.00" }],
    ["an unknown kind", { kind: "JACKPOT" }],
    ["an unknown status", { status: "LOST" }],
    ["an empty reference", { kind: "WIN", reference_external_transaction_id: "" }],
  ])("rejects %s", async (_, overrides) => {
    const { walletId, playerId } = await aWallet();

    await expectSqlError(
      () => inTransaction(orm, (sql) => insertTransaction(sql, walletId, playerId, overrides).then(() => {})),
      CHECK_VIOLATION,
    );
  });

  test("accepts a zero LOSS", async () => {
    const { walletId, playerId } = await aWallet();

    await inTransaction(orm, (sql) =>
      insertTransaction(sql, walletId, playerId, { kind: "LOSS", amount: "0.00" }).then(() => {}),
    );
  });

  test("refuses a transaction for a missing wallet at commit", async () => {
    await expectSqlError(
      () => inTransaction(orm, (sql) => insertTransaction(sql, id(), "player").then(() => {})),
      FOREIGN_KEY_VIOLATION,
    );
  });

  test("allows only one processed reversal per reference, of any kind", async () => {
    const { walletId, playerId } = await aWallet();
    let betId = "";
    let betExternalId = "";

    await inTransaction(orm, async (sql) => {
      const bet = await insertTransaction(sql, walletId, playerId, processed);
      betId = bet.id;
      betExternalId = bet.external_transaction_id;
      const reference = {
        reference_external_transaction_id: bet.external_transaction_id,
        reference_transaction_id: bet.id,
      };
      await insertTransaction(sql, walletId, playerId, { kind: "REFUND", ...reference, ...processed });
      await insertTransaction(sql, walletId, playerId, {
        kind: "ROLLBACK",
        ...reference,
        status: "REJECTED",
        failure_code: "REFERENCE_ALREADY_REVERSED",
        result_balance: "90.00",
      });
    });

    await expectSqlError(
      () =>
        inTransaction(orm, (sql) =>
          insertTransaction(sql, walletId, playerId, {
            kind: "ROLLBACK",
            reference_external_transaction_id: betExternalId,
            reference_transaction_id: betId,
            ...processed,
          }).then(() => {}),
        ),
      UNIQUE_VIOLATION,
    );
  });

  test("refuses a processed reversal without the resolved reference id", async () => {
    const { walletId, playerId } = await aWallet();

    await expectSqlError(
      () =>
        inTransaction(orm, (sql) =>
          insertTransaction(sql, walletId, playerId, {
            kind: "REFUND",
            reference_external_transaction_id: id(),
            ...processed,
          }).then(() => {}),
        ),
      CHECK_VIOLATION,
    );
  });

  test("refuses a resolved reference that is not the declared one", async () => {
    const { walletId, playerId } = await aWallet();

    await expectSqlError(
      () =>
        inTransaction(orm, async (sql) => {
          const declared = await insertTransaction(sql, walletId, playerId, processed);
          const other = await insertTransaction(sql, walletId, playerId, processed);
          await insertTransaction(sql, walletId, playerId, {
            kind: "REFUND",
            reference_external_transaction_id: declared.external_transaction_id,
            reference_transaction_id: other.id,
            ...processed,
          });
        }),
      FOREIGN_KEY_VIOLATION,
    );
  });

  test.each(["PROCESSED", "REJECTED", "FAILED"])("freezes a %s transaction", async (status) => {
    const { walletId, playerId } = await aWallet();
    const terminal = {
      PROCESSED: processed,
      REJECTED: { status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS", result_balance: "1.00" },
      FAILED: { status: "FAILED", failure_code: "INFRASTRUCTURE_FAILURE" },
    }[status as "PROCESSED" | "REJECTED" | "FAILED"];
    let transactionId = "";

    await inTransaction(orm, async (sql) => {
      transactionId = (await insertTransaction(sql, walletId, playerId, terminal)).id;
    });

    await expectSqlError(
      () =>
        inTransaction(orm, (sql) =>
          sql("update wager_transactions set reference_attempts = 1 where id = ?", [transactionId]).then(() => {}),
        ),
      RAISED_EXCEPTION,
    );
  });

  test("allows a pending transaction to settle, but not to change its business fields", async () => {
    const { walletId, playerId } = await aWallet();
    let transactionId = "";

    await inTransaction(orm, async (sql) => {
      transactionId = (await insertTransaction(sql, walletId, playerId)).id;
    });

    await expectSqlError(
      () =>
        inTransaction(orm, (sql) =>
          sql("update wager_transactions set amount = 99 where id = ?", [transactionId]).then(() => {}),
        ),
      RAISED_EXCEPTION,
    );

    await inTransaction(orm, (sql) =>
      sql(
        "update wager_transactions set status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS', result_balance = 1, result_balance_currency = 'BRL' where id = ?",
        [transactionId],
      ).then(() => {}),
    );
  });

  test("cannot be deleted", async () => {
    const { opening } = await aWallet();

    await expectSqlError(
      () =>
        inTransaction(orm, (sql) =>
          sql("delete from wager_transactions where id = ?", [opening?.transaction.id]).then(() => {}),
        ),
      RAISED_EXCEPTION,
    );
  });
});

describe("wallet_ledger_entries", () => {
  test.each([
    ["update", "update wallet_ledger_entries set amount = amount where wallet_id = ?"],
    ["delete", "delete from wallet_ledger_entries where wallet_id = ?"],
  ])("rejects %s", async (_, query) => {
    const { walletId } = await aWallet();

    await expectSqlError(() => inTransaction(orm, (sql) => sql(query, [walletId]).then(() => {})), RAISED_EXCEPTION);
  });

  test("rejects truncate", async () => {
    await aWallet();

    await expectSqlError(
      () => inTransaction(orm, (sql) => sql("truncate wallet_ledger_entries cascade").then(() => {})),
      RAISED_EXCEPTION,
    );
  });

  async function insertEntry(
    sql: Sql,
    walletId: string,
    transactionId: string,
    values: {
      direction?: string;
      amount?: string;
      currency?: string;
      before?: string;
      after?: string;
      version?: number;
    },
  ) {
    await sql(
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, now())`,
      [
        id(),
        walletId,
        transactionId,
        values.direction ?? "DEBIT",
        values.amount ?? "10.00",
        values.currency ?? "BRL",
        values.before ?? "100.00",
        values.after ?? "90.00",
        values.version ?? 2,
      ],
    );
  }

  test("accepts a consistent debit together with the wallet update", async () => {
    const { walletId, playerId } = await aWallet();

    await inTransaction(orm, async (sql) => {
      const bet = await insertTransaction(sql, walletId, playerId, processed);
      await insertEntry(sql, walletId, bet.id, {});
      await sql("update wallets set balance = 90, version = 2 where id = ?", [walletId]);
    });
  });

  test("rejects arithmetic that does not add up", async () => {
    const { walletId, playerId } = await aWallet();

    await expectSqlError(
      () =>
        inTransaction(orm, async (sql) => {
          const bet = await insertTransaction(sql, walletId, playerId, processed);
          await insertEntry(sql, walletId, bet.id, { after: "91.00" });
        }),
      CHECK_VIOLATION,
    );
  });

  test("rejects a zero amount", async () => {
    const { walletId, playerId } = await aWallet();

    await expectSqlError(
      () =>
        inTransaction(orm, async (sql) => {
          const bet = await insertTransaction(sql, walletId, playerId, processed);
          await insertEntry(sql, walletId, bet.id, { amount: "0.00", after: "100.00" });
        }),
      CHECK_VIOLATION,
    );
  });

  test("rejects an entry that breaks the balance chain", async () => {
    const { walletId, playerId } = await aWallet();

    await expectSqlError(
      () =>
        inTransaction(orm, async (sql) => {
          const bet = await insertTransaction(sql, walletId, playerId, processed);
          await insertEntry(sql, walletId, bet.id, { before: "200.00", after: "190.00" });
          await sql("update wallets set balance = 190, version = 2 where id = ?", [walletId]);
        }),
      RAISED_EXCEPTION,
    );
  });

  test("rejects a second entry at the same wallet version", async () => {
    const { walletId, playerId } = await aWallet();

    await expectSqlError(
      () =>
        inTransaction(orm, async (sql) => {
          const bet = await insertTransaction(sql, walletId, playerId, processed);
          await insertEntry(sql, walletId, bet.id, {
            version: 1,
            before: "0.00",
            amount: "90.00",
            direction: "CREDIT",
          });
        }),
      UNIQUE_VIOLATION,
    );
  });

  test("rejects a second entry for the same transaction", async () => {
    const { walletId, opening } = await aWallet();

    await expectSqlError(
      () =>
        inTransaction(orm, (sql) =>
          insertEntry(sql, walletId, opening?.transaction.id ?? "", { direction: "CREDIT", after: "110.00" }),
        ),
      UNIQUE_VIOLATION,
    );
  });

  test("rejects an entry in another currency than the wallet at commit", async () => {
    const { walletId, playerId } = await aWallet();

    await expectSqlError(
      () =>
        inTransaction(orm, async (sql) => {
          const bet = await insertTransaction(sql, walletId, playerId, { ...processed, currency: "USD" });
          await insertEntry(sql, walletId, bet.id, { currency: "USD" });
          await sql("update wallets set balance = 90, version = 2 where id = ?", [walletId]);
        }),
      FOREIGN_KEY_VIOLATION,
    );
  });

  test.each<[string, Partial<TransactionRow>, Parameters<typeof insertEntry>[3]]>([
    ["a LOSS", { ...processed, kind: "LOSS" }, { direction: "CREDIT", after: "110.00" }],
    ["a REJECTED BET", { status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS", result_balance: "100.00" }, {}],
    ["a pending BET", {}, {}],
    ["a different amount", processed, { amount: "9.00", after: "91.00" }],
    ["a different currency", { ...processed, currency: "USD" }, {}],
    ["the wrong direction", { ...processed, kind: "WIN" }, {}],
  ])("refuses at commit an entry that does not match %s", async (_, transaction, entry) => {
    const { walletId, playerId } = await aWallet();

    await expectSqlError(
      () =>
        inTransaction(orm, async (sql) => {
          const created = await insertTransaction(sql, walletId, playerId, transaction);
          await insertEntry(sql, walletId, created.id, entry);
          await sql("update wallets set balance = ?, version = 2 where id = ?", [entry.after ?? "90.00", walletId]);
        }),
      RAISED_EXCEPTION,
    );
  });

  test("accepts a ROLLBACK of a WIN as a debit and rejects it as a credit", async () => {
    const { walletId, playerId } = await aWallet();

    await inTransaction(orm, async (sql) => {
      const win = await insertTransaction(sql, walletId, playerId, {
        ...processed,
        kind: "WIN",
        result_balance: "110.00",
      });
      await insertEntry(sql, walletId, win.id, { direction: "CREDIT", after: "110.00" });
      await sql("update wallets set balance = 110, version = 2 where id = ?", [walletId]);
      const rollback = await insertTransaction(sql, walletId, playerId, {
        ...processed,
        kind: "ROLLBACK",
        reference_external_transaction_id: win.external_transaction_id,
        reference_transaction_id: win.id,
      });
      await insertEntry(sql, walletId, rollback.id, {
        direction: "DEBIT",
        before: "110.00",
        after: "100.00",
        version: 3,
      });
      await sql("update wallets set balance = 100, version = 3 where id = ?", [walletId]);
    });

    const other = await aWallet();
    await expectSqlError(
      () =>
        inTransaction(orm, async (sql) => {
          const win = await insertTransaction(sql, other.walletId, other.playerId, { ...processed, kind: "WIN" });
          await insertEntry(sql, other.walletId, win.id, { direction: "CREDIT", after: "110.00" });
          await sql("update wallets set balance = 110, version = 2 where id = ?", [other.walletId]);
          const rollback = await insertTransaction(sql, other.walletId, other.playerId, {
            ...processed,
            kind: "ROLLBACK",
            reference_external_transaction_id: win.external_transaction_id,
            reference_transaction_id: win.id,
          });
          await insertEntry(sql, other.walletId, rollback.id, {
            direction: "CREDIT",
            before: "110.00",
            after: "120.00",
            version: 3,
          });
          await sql("update wallets set balance = 120, version = 3 where id = ?", [other.walletId]);
        }),
      RAISED_EXCEPTION,
    );
  });

  test.each<[string, string, Parameters<typeof insertEntry>[3]]>([
    ["skips versions after the opening", "100.00", { before: "100.00", version: 5 }],
    [
      "starts at a high version on an opened wallet",
      "100.00",
      { before: "0.00", direction: "CREDIT", after: "10.00", version: 99 },
    ],
    [
      "starts above version 2 on an empty wallet",
      "0.00",
      { before: "0.00", direction: "CREDIT", after: "10.00", version: 3 },
    ],
  ])("refuses an entry that %s", async (_, initialBalance, entry) => {
    const { walletId, playerId } = await aWallet(initialBalance);

    await expectSqlError(
      () =>
        inTransaction(orm, async (sql) => {
          const kind = entry.direction === "CREDIT" ? "WIN" : "BET";
          const created = await insertTransaction(sql, walletId, playerId, { ...processed, kind });
          await insertEntry(sql, walletId, created.id, entry);
          await sql("update wallets set balance = ?, version = ? where id = ?", [
            entry.after ?? "90.00",
            entry.version,
            walletId,
          ]);
        }),
      RAISED_EXCEPTION,
    );
  });

  test("refuses a skipped ledger version even when the wallet walks up to it", async () => {
    const { walletId, playerId } = await aWallet("100.00");

    await expectSqlError(
      () =>
        inTransaction(orm, async (sql) => {
          const win = await insertTransaction(sql, walletId, playerId, { ...processed, kind: "WIN" });
          await insertEntry(sql, walletId, win.id, { direction: "CREDIT", before: "0.00", after: "10.00", version: 5 });
          for (const [balance, version] of [
            ["99", 2],
            ["98", 3],
            ["97", 4],
            ["10", 5],
          ] as const) {
            await sql("update wallets set balance = ?, version = ? where id = ?", [balance, version, walletId]);
          }
        }),
      RAISED_EXCEPTION,
    );
  });

  test("accepts the first movement of an empty wallet at version 2", async () => {
    const { walletId, playerId } = await aWallet("0.00");

    await inTransaction(orm, async (sql) => {
      const win = await insertTransaction(sql, walletId, playerId, { ...processed, kind: "WIN" });
      await insertEntry(sql, walletId, win.id, { direction: "CREDIT", before: "0.00", after: "10.00" });
      await sql("update wallets set balance = 10, version = 2 where id = ?", [walletId]);
    });
  });

  test("rejects an entry for a transaction of another wallet at commit", async () => {
    const first = await aWallet();
    const second = await aWallet();

    await expectSqlError(
      () =>
        inTransaction(orm, async (sql) => {
          const bet = await insertTransaction(sql, second.walletId, second.playerId, processed);
          await insertEntry(sql, first.walletId, bet.id, {});
          await sql("update wallets set balance = 90, version = 2 where id = ?", [first.walletId]);
        }),
      FOREIGN_KEY_VIOLATION,
    );
  });

  test("refuses to commit an entry without the matching wallet update", async () => {
    const { walletId, playerId } = await aWallet();

    await expectSqlError(
      () =>
        inTransaction(orm, async (sql) => {
          const bet = await insertTransaction(sql, walletId, playerId, processed);
          await insertEntry(sql, walletId, bet.id, {});
        }),
      RAISED_EXCEPTION,
    );
  });
});

describe("inbox_messages", () => {
  const insertInbox = (consumer: string, messageId: string) =>
    inTransaction(orm, (sql) =>
      sql("insert into inbox_messages values (?, ?, ?, now(), null)", [consumer, messageId, HASH]).then(() => {}),
    );

  test("deduplicates per consumer and message id", async () => {
    const messageId = id();

    await insertInbox("wagers", messageId);
    await insertInbox("audit", messageId);

    await expectSqlError(() => insertInbox("wagers", messageId), UNIQUE_VIOLATION);
  });
});
