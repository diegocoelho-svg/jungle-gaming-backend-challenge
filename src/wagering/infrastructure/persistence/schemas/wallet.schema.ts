import { EntitySchema } from "@mikro-orm/core";

export class WalletSchema {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletEntitySchema = new EntitySchema<WalletSchema>({
  class: WalletSchema,
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "text" },
    currency: { type: "text" },
    balance: { type: "decimal", columnType: "numeric(20,2)" },
    version: { type: "integer" },
    createdAt: { type: "datetime", columnType: "timestamptz" },
    updatedAt: { type: "datetime", columnType: "timestamptz" },
  },
});
