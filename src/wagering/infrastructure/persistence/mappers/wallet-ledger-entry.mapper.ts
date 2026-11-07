import { type LedgerDirection, WalletLedgerEntry } from "../../../domain/entities/wallet-ledger-entry.entity";
import { Money } from "../../../domain/value-objects/money.vo";
import { WalletLedgerEntrySchema } from "../schemas/wallet-ledger-entry.schema";

export function ledgerEntryToDomain(row: WalletLedgerEntrySchema): WalletLedgerEntry {
  const money = (amount: string) => Money.rehydrate({ amount, currency: row.currency });

  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.walletId,
    transactionId: row.transactionId,
    direction: row.direction as LedgerDirection,
    money: money(row.amount),
    balanceBefore: money(row.balanceBefore),
    balanceAfter: money(row.balanceAfter),
    walletVersion: row.walletVersion,
    createdAt: row.createdAt,
  });
}

export function ledgerEntryToSchema(entry: WalletLedgerEntry): WalletLedgerEntrySchema {
  const row = new WalletLedgerEntrySchema();
  row.id = entry.id;
  row.walletId = entry.walletId;
  row.transactionId = entry.transactionId;
  row.direction = entry.direction;
  row.amount = entry.money.toJSON().amount;
  row.currency = entry.money.currency;
  row.balanceBefore = entry.balanceBefore.toJSON().amount;
  row.balanceAfter = entry.balanceAfter.toJSON().amount;
  row.walletVersion = entry.walletVersion;
  row.createdAt = entry.createdAt;
  return row;
}
