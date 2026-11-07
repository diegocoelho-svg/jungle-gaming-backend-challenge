import { WagerTransaction } from "../entities/wager-transaction.entity";
import { LedgerDirection, WalletLedgerEntry } from "../entities/wallet-ledger-entry.entity";
import { Wallet } from "../entities/wallet.entity";
import { Money } from "../value-objects/money.vo";

export interface OpenWalletInput {
  walletId: string;
  playerId: string;
  initialBalance: Money;
  openingTransactionId: string;
  openingEntryId: string;
  at: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  opening?: { transaction: WagerTransaction; entry: WalletLedgerEntry };
}

export function openWallet(input: OpenWalletInput): OpenedWallet {
  const { walletId, playerId, initialBalance, openingTransactionId, openingEntryId, at } = input;
  const wallet = Wallet.open({ id: walletId, playerId, initialBalance, at });

  if (initialBalance.isZero()) return { wallet };

  return {
    wallet,
    opening: {
      transaction: WagerTransaction.opening({
        id: openingTransactionId,
        walletId,
        playerId,
        money: initialBalance,
        at,
      }),
      entry: WalletLedgerEntry.create({
        id: openingEntryId,
        walletId,
        transactionId: openingTransactionId,
        direction: LedgerDirection.Credit,
        money: initialBalance,
        balanceBefore: Money.zero(initialBalance.currency),
        balanceAfter: initialBalance,
        walletVersion: wallet.version,
        createdAt: at,
      }),
    },
  };
}
