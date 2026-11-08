import type { OutboxMessage } from "../../domain/entities/outbox-message.entity";

export const EVENT_PUBLISHER = Symbol("EVENT_PUBLISHER");

export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<ReadonlySet<string>>;
}
