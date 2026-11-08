import { GetQueueUrlCommand, SendMessageBatchCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { EventPublisher } from "../../application/ports/event-publisher.port";
import type { ApplicationLogger } from "../../application/ports/runtime.port";
import type { OutboxMessage } from "../../domain/entities/outbox-message.entity";

const SQS_BATCH_LIMIT = 10;

export class SqsEventPublisher implements EventPublisher {
  private queueUrl?: string;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
    private readonly logger: ApplicationLogger,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<ReadonlySet<string>> {
    const published = new Set<string>();
    for (let start = 0; start < messages.length; start += SQS_BATCH_LIMIT) {
      for (const id of await this.sendBatch(messages.slice(start, start + SQS_BATCH_LIMIT))) published.add(id);
    }
    return published;
  }

  private async sendBatch(batch: readonly OutboxMessage[]): Promise<string[]> {
    try {
      const { Successful } = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: await this.url(),
          Entries: batch.map((message, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: message.id,
            MessageAttributes: { eventType: { DataType: "String", StringValue: message.eventType } },
          })),
        }),
      );
      return (Successful ?? []).flatMap((entry) => {
        const message = batch[Number(entry.Id)];
        return message ? [message.id] : [];
      });
    } catch (error) {
      this.logger.warn({ err: error, context: "outbox-publisher" }, "event batch could not be sent");
      return [];
    }
  }

  private async url(): Promise<string> {
    if (this.queueUrl) return this.queueUrl;
    const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }));
    if (!QueueUrl) throw new Error(`Queue not found: ${this.queueName}`);
    this.queueUrl = QueueUrl;
    return QueueUrl;
  }
}
