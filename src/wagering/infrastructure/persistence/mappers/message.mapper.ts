import { InboxMessage } from "../../../domain/entities/inbox-message.entity";
import { OutboxMessage } from "../../../domain/entities/outbox-message.entity";
import { InboxMessageSchema } from "../schemas/inbox-message.schema";
import { OutboxMessageSchema } from "../schemas/outbox-message.schema";

export function inboxMessageToDomain(row: InboxMessageSchema): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: row.consumerName,
    messageId: row.messageId,
    payloadHash: row.payloadHash,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt ?? undefined,
  });
}

export function inboxMessageToSchema(
  message: InboxMessage,
  row: InboxMessageSchema = new InboxMessageSchema(),
): InboxMessageSchema {
  row.consumerName = message.consumerName;
  row.messageId = message.messageId;
  row.payloadHash = message.payloadHash;
  row.receivedAt = message.receivedAt;
  row.processedAt = message.processedAt ?? null;
  return row;
}

export function outboxMessageToDomain(row: OutboxMessageSchema): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload: row.payload,
    occurredAt: row.occurredAt,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt ?? undefined,
    publishedAt: row.publishedAt ?? undefined,
  });
}

export function outboxMessageToSchema(
  message: OutboxMessage,
  row: OutboxMessageSchema = new OutboxMessageSchema(),
): OutboxMessageSchema {
  row.id = message.id;
  row.aggregateId = message.aggregateId;
  row.eventType = message.eventType;
  row.payload = { ...message.payload };
  row.occurredAt = message.occurredAt;
  row.attempts = message.attempts;
  row.nextAttemptAt = message.nextAttemptAt ?? null;
  row.publishedAt = message.publishedAt ?? null;
  return row;
}
