import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApiApp } from "../../../src/bootstrap";
import { loadEnv } from "../../../src/core/config/env";
import { WalletNotFoundError } from "../../../src/wagering/application/errors/application.error";
import {
  type ProcessWagerTransactionCommand,
  ProcessWagerTransactionUseCase,
} from "../../../src/wagering/application/use-cases/process-wager-transaction.use-case";
import { InboxMessage } from "../../../src/wagering/domain/entities/inbox-message.entity";
import { WagerTransactionKind } from "../../../src/wagering/domain/entities/wager-transaction.entity";
import { createWallet, startTestApi, type TestApi } from "../../support/api";
import { id } from "../../support/database";

let api: TestApi;
let app: Awaited<ReturnType<typeof createApiApp>>;
let useCase: ProcessWagerTransactionUseCase;

beforeAll(async () => {
  api = await startTestApi();
  app = await createApiApp(loadEnv());
  await app.init();
  useCase = app.get(ProcessWagerTransactionUseCase);
});

afterAll(async () => {
  await app.close();
  await api.close();
});

const correlation = { correlationId: "corr-1", causationId: "msg" };

const inboxFor = (messageId: string, payloadHash = "a".repeat(64)) =>
  InboxMessage.receive({ consumerName: "wager-transactions", messageId, payloadHash, receivedAt: new Date() });

const commandFor = (wallet: { id: string; playerId: string }, amount = "10.00"): ProcessWagerTransactionCommand => {
  const externalTransactionId = id();
  return {
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: { amount, currency: "BRL" },
  };
};

const count = async (table: string, where: string, params: unknown[]) => {
  const [row] = await api.orm.em
    .getConnection()
    .execute<{ total: number }[]>(`select count(*)::int as total from ${table} where ${where}`, params);
  return row?.total ?? 0;
};

describe("processing from a queue message", () => {
  test("settles once and records the inbox entry in the same transaction", async () => {
    const wallet = await createWallet(api, "100.00");
    const messageId = id();

    const result = await useCase.executeFromMessage(commandFor(wallet), correlation, inboxFor(messageId));

    expect(result.kind).toBe("settled");
    expect(await count("inbox_messages", "message_id = ? and processed_at is not null", [messageId])).toBe(1);
    expect(await count("wallet_ledger_entries", "wallet_id = ?", [wallet.id])).toBe(2);
  });

  test("a redelivered message is a duplicate and changes nothing", async () => {
    const wallet = await createWallet(api, "100.00");
    const messageId = id();
    const command = commandFor(wallet);

    await useCase.executeFromMessage(command, correlation, inboxFor(messageId));
    const redelivery = await useCase.executeFromMessage(command, correlation, inboxFor(messageId));

    expect(redelivery).toEqual({ kind: "duplicate-message", storedPayloadHash: "a".repeat(64) });
    expect(await count("wager_transactions", "wallet_id = ? and kind = 'BET'", [wallet.id])).toBe(1);
  });

  test("the same message delivered concurrently settles once", async () => {
    const wallet = await createWallet(api, "100.00");
    const messageId = id();
    const command = commandFor(wallet);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => useCase.executeFromMessage(command, correlation, inboxFor(messageId))),
    );

    expect(results.filter((result) => result.kind === "settled")).toHaveLength(1);
    expect(await count("wallet_ledger_entries", "wallet_id = ? and direction = 'DEBIT'", [wallet.id])).toBe(1);
  });

  test("a new message for an already processed transaction is recorded and answered as a replay", async () => {
    const wallet = await createWallet(api, "100.00");
    const command = commandFor(wallet);
    await useCase.executeFromMessage(command, correlation, inboxFor(id()));
    const secondMessage = id();

    const result = await useCase.executeFromMessage(command, correlation, inboxFor(secondMessage));

    expect(result.kind === "settled" && result.outcome.idempotentReplay).toBe(true);
    expect(await count("inbox_messages", "message_id = ? and processed_at is not null", [secondMessage])).toBe(1);
  });

  test("an idempotency conflict is a terminal outcome that keeps the inbox entry", async () => {
    const wallet = await createWallet(api, "100.00");
    const command = commandFor(wallet);
    await useCase.executeFromMessage(command, correlation, inboxFor(id()));
    const conflicting = id();

    const result = await useCase.executeFromMessage(
      { ...command, money: { amount: "99.00", currency: "BRL" } },
      correlation,
      inboxFor(conflicting),
    );

    expect(result.kind).toBe("idempotency-conflict");
    expect(await count("inbox_messages", "message_id = ? and processed_at is not null", [conflicting])).toBe(1);
    expect(await count("wager_transactions", "wallet_id = ? and kind = 'BET'", [wallet.id])).toBe(1);
  });

  test("a failure rolls the inbox entry back so the message can be redelivered", async () => {
    const messageId = id();
    const command = commandFor({ id: id(), playerId: id() });

    await expect(useCase.executeFromMessage(command, correlation, inboxFor(messageId))).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );

    expect(await count("inbox_messages", "message_id = ?", [messageId])).toBe(0);
  });
});
