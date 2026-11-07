import { EntitySchema } from "@mikro-orm/core";

export class InboxMessageSchema {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export const InboxMessageEntitySchema = new EntitySchema<InboxMessageSchema>({
  class: InboxMessageSchema,
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "text", primary: true },
    messageId: { type: "text", primary: true },
    payloadHash: { type: "text" },
    receivedAt: { type: "datetime", columnType: "timestamptz" },
    processedAt: { type: "datetime", columnType: "timestamptz", nullable: true },
  },
});
