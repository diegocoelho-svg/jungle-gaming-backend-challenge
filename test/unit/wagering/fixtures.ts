import { Wallet } from "../../../src/wagering/domain/entities/wallet.entity";
import {
  WagerTransaction,
  WagerTransactionKind,
  type CreateWagerTransactionProps,
} from "../../../src/wagering/domain/entities/wager-transaction.entity";
import {
  settleTransaction,
  type SettlementResult,
} from "../../../src/wagering/domain/services/settle-transaction.service";
import { Money } from "../../../src/wagering/domain/value-objects/money.vo";

export const NOW = new Date("2026-11-07T12:00:00.000Z");
export const WALLET_ID = "wallet-1";
export const PLAYER_ID = "player-1";

export const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });

export const aWallet = (balance = "100.00"): Wallet =>
  Wallet.open({ id: WALLET_ID, playerId: PLAYER_ID, initialBalance: brl(balance), at: NOW });

let sequence = 0;

export function aTransaction(
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  sequence += 1;
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${sequence}`;

  return WagerTransaction.create({
    id: `id-${sequence}`,
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: "hash",
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: brl(amount),
    createdAt: NOW,
    ...overrides,
  });
}

export function settle(
  transaction: WagerTransaction,
  wallet: Wallet,
  options: { reference?: WagerTransaction; referenceAlreadyReversed?: boolean; at?: Date } = {},
): SettlementResult {
  return settleTransaction({
    transaction,
    wallet,
    ...(options.reference && { reference: options.reference }),
    referenceAlreadyReversed: options.referenceAlreadyReversed ?? false,
    ledgerEntryId: `entry-${transaction.id}`,
    at: options.at ?? NOW,
  });
}

export function aProcessed(kind: WagerTransactionKind, amount: string, wallet: Wallet): WagerTransaction {
  const transaction = aTransaction(kind, amount);
  settle(transaction, wallet);
  return transaction;
}
