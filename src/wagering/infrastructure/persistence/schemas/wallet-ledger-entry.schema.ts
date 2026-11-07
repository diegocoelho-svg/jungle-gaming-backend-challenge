import { EntitySchema } from "@mikro-orm/core";

export class WalletLedgerEntrySchema {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

export const WalletLedgerEntryEntitySchema = new EntitySchema<WalletLedgerEntrySchema>({
  class: WalletLedgerEntrySchema,
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid" },
    transactionId: { type: "uuid" },
    direction: { type: "text" },
    amount: { type: "decimal", columnType: "numeric(20,2)" },
    currency: { type: "text" },
    balanceBefore: { type: "decimal", columnType: "numeric(20,2)" },
    balanceAfter: { type: "decimal", columnType: "numeric(20,2)" },
    walletVersion: { type: "integer" },
    createdAt: { type: "datetime", columnType: "timestamptz" },
  },
});
