import { EntitySchema } from "@mikro-orm/core";

export class WagerTransactionSchema {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  status!: string;
  failureCode!: string | null;
  resultBalance!: string | null;
  resultBalanceCurrency!: string | null;
  referenceAttempts!: number;
  nextReferenceAttemptAt!: Date | null;
  createdAt!: Date;
  processedAt!: Date | null;
}

export const WagerTransactionEntitySchema = new EntitySchema<WagerTransactionSchema>({
  class: WagerTransactionSchema,
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "text" },
    externalTransactionId: { type: "text" },
    idempotencyKey: { type: "text" },
    payloadHash: { type: "text" },
    walletId: { type: "uuid" },
    playerId: { type: "text" },
    roundId: { type: "text" },
    gameId: { type: "text" },
    kind: { type: "text" },
    amount: { type: "decimal", columnType: "numeric(20,2)" },
    currency: { type: "text" },
    referenceExternalTransactionId: { type: "text", nullable: true },
    referenceTransactionId: { type: "uuid", nullable: true },
    status: { type: "text" },
    failureCode: { type: "text", nullable: true },
    resultBalance: { type: "decimal", columnType: "numeric(20,2)", nullable: true },
    resultBalanceCurrency: { type: "text", nullable: true },
    referenceAttempts: { type: "integer" },
    nextReferenceAttemptAt: { type: "datetime", columnType: "timestamptz", nullable: true },
    createdAt: { type: "datetime", columnType: "timestamptz" },
    processedAt: { type: "datetime", columnType: "timestamptz", nullable: true },
  },
});
