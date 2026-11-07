import { EntitySchema } from "@mikro-orm/core";

export class OutboxMessageSchema {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date | null;
  publishedAt!: Date | null;
}

export const OutboxMessageEntitySchema = new EntitySchema<OutboxMessageSchema>({
  class: OutboxMessageSchema,
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "text" },
    eventType: { type: "text" },
    payload: { type: "json", columnType: "jsonb" },
    occurredAt: { type: "datetime", columnType: "timestamptz" },
    attempts: { type: "integer" },
    nextAttemptAt: { type: "datetime", columnType: "timestamptz", nullable: true },
    publishedAt: { type: "datetime", columnType: "timestamptz", nullable: true },
  },
});
