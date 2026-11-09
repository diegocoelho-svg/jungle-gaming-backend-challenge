import { describe, expect, test } from "bun:test";
import { IdempotencyConflictError } from "../../../src/wagering/application/errors/application.error";
import type {
  WageringRepositories,
  WageringUnitOfWork,
  WagerTransactionRepository,
} from "../../../src/wagering/application/ports/wagering-unit-of-work.port";
import {
  type ProcessWagerTransactionCommand,
  ProcessWagerTransactionUseCase,
} from "../../../src/wagering/application/use-cases/process-wager-transaction.use-case";
import type { WagerTransaction } from "../../../src/wagering/domain/entities/wager-transaction.entity";
import { WagerTransactionKind } from "../../../src/wagering/domain/entities/wager-transaction.entity";
import { computePayloadHash } from "../../../src/wagering/domain/services/payload-hash.service";
import { aTransaction, aWallet } from "./fixtures";

const command: ProcessWagerTransactionCommand = {
  providerId: "provider-a",
  externalTransactionId: "tx-race",
  idempotencyKey: "provider-a:tx-race",
  playerId: "player-1",
  walletId: "wallet-1",
  roundId: "round-1",
  gameId: "game-1",
  kind: WagerTransactionKind.Bet,
  money: { amount: "10.00", currency: "BRL" },
};

function useCaseSeeing(byExternalId: WagerTransaction) {
  const transactions = {
    findByIdempotencyKey: async () => undefined,
    findByExternalId: async () => byExternalId,
  } as unknown as WagerTransactionRepository;
  const unitOfWork: WageringUnitOfWork = {
    read: (work) => work({ transactions } as WageringRepositories),
    transaction: () => Promise.reject(new Error("should not open a transaction")),
  };
  const silent = { info: () => {}, warn: () => {} };

  return new ProcessWagerTransactionUseCase(unitOfWork, { next: () => "id" }, { now: () => new Date() }, silent);
}

describe("ProcessWagerTransactionUseCase idempotency", () => {
  test("a duplicate committed between the two lookups is a replay, not a conflict", async () => {
    const committed = aTransaction(WagerTransactionKind.Bet, "10.00", {
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: computePayloadHash(command),
    });

    const outcome = await useCaseSeeing(committed).execute(command, { correlationId: "c" });

    expect(outcome).toEqual({ transaction: committed, idempotentReplay: true });
  });

  test("the same external id under another key is still a conflict", async () => {
    const committed = aTransaction(WagerTransactionKind.Bet, "10.00", {
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: "provider-a:other-key",
      payloadHash: computePayloadHash(command),
    });

    await expect(useCaseSeeing(committed).execute(command, { correlationId: "c" })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });
});

function useCaseCommitting(commit: () => Promise<void>) {
  const logged: string[] = [];
  const wallet = aWallet("100.00");
  const repositories = {
    wallets: { findForUpdate: async () => wallet, save: () => {} },
    transactions: {
      findByIdempotencyKey: async () => undefined,
      findByExternalId: async () => undefined,
      add: () => {},
    },
    ledger: { append: () => {} },
    outbox: { enqueue: () => {} },
  } as unknown as WageringRepositories;
  const unitOfWork: WageringUnitOfWork = {
    read: (work) => work(repositories),
    transaction: async (work) => {
      const result = await work(repositories);
      await commit();
      return result;
    },
  };
  let sequence = 0;
  const logger = { info: (_: unknown, message: string) => logged.push(message), warn: () => {} };
  const useCase = new ProcessWagerTransactionUseCase(
    unitOfWork,
    { next: () => `id-${(sequence += 1)}` },
    { now: () => new Date() },
    logger,
  );
  return { useCase, logged };
}

describe("ProcessWagerTransactionUseCase logging", () => {
  test("a settlement is logged once it is committed", async () => {
    const { useCase, logged } = useCaseCommitting(async () => {});

    await useCase.execute(command, { correlationId: "c" });

    expect(logged).toEqual(["wager transaction settled"]);
  });

  test("a settlement whose commit fails is not logged", async () => {
    const { useCase, logged } = useCaseCommitting(() => Promise.reject(new Error("commit failed")));

    await expect(useCase.execute(command, { correlationId: "c" })).rejects.toThrow("commit failed");

    expect(logged).not.toContain("wager transaction settled");
  });
});
