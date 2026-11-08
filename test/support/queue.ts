import "reflect-metadata";
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  type Message,
  DeleteMessageCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";
import { loadEnv } from "../../src/core/config/env";
import { createSqsClient } from "../../src/core/messaging/sqs.client";
import { WAGER_MESSAGE_TYPE } from "../../src/wagering/presentation/messaging/wager-message.parser";
import { id } from "./database";

export const testEnv = (overrides: Record<string, string> = {}) =>
  loadEnv({ ...process.env, APP_ROLE: "consumer", ...overrides });

export const testSqs = (): SQSClient => createSqsClient(testEnv());

export async function queueUrl(sqs: SQSClient, name: string): Promise<string> {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!QueueUrl) throw new Error(`Queue not found: ${name}`);
  return QueueUrl;
}

export async function createRetryQueues(sqs: SQSClient, maxReceiveCount: number, visibilityTimeout = 30) {
  const suffix = id().slice(-12);
  const dlqName = `test-retry-dlq-${suffix}.fifo`;
  const queueName = `test-retry-${suffix}.fifo`;
  const dlqUrl = (await sqs.send(new CreateQueueCommand({ QueueName: dlqName, Attributes: { FifoQueue: "true" } })))
    .QueueUrl!;
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }),
  );
  await sqs.send(
    new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        FifoQueue: "true",
        VisibilityTimeout: String(visibilityTimeout),
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes!.QueueArn, maxReceiveCount }),
      },
    }),
  );
  return { queueName, dlqName };
}

export async function purge(sqs: SQSClient, ...names: string[]): Promise<void> {
  for (const name of names) await sqs.send(new PurgeQueueCommand({ QueueUrl: await queueUrl(sqs, name) }));
}

export async function startConsumer(overrides: Record<string, string> = {}) {
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(testEnv(overrides)), { logger: false });
  return app;
}

export interface WagerEnvelopeData {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export function wagerData(wallet: { id: string; playerId: string }, overrides: Partial<WagerEnvelopeData> = {}) {
  const externalTransactionId = overrides.externalTransactionId ?? id();
  return {
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "game-1",
    kind: "BET",
    money: { amount: "10.00", currency: "BRL" },
    ...overrides,
  };
}

export const envelope = (data: unknown, messageId = id()) =>
  JSON.stringify({ messageId, type: WAGER_MESSAGE_TYPE, occurredAt: new Date().toISOString(), data });

export async function sendRaw(sqs: SQSClient, queueName: string, body: string, groupId = "group-1"): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: await queueUrl(sqs, queueName),
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: id(),
    }),
  );
}

export async function drain(sqs: SQSClient, queueName: string, waitSeconds = 1): Promise<Message[]> {
  const url = await queueUrl(sqs, queueName);
  const messages: Message[] = [];
  for (;;) {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitSeconds,
        MessageAttributeNames: ["All"],
      }),
    );
    if (!Messages?.length) return messages;
    messages.push(...Messages);
    for (const message of Messages) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }));
    }
  }
}

export async function pendingCount(sqs: SQSClient, queueName: string): Promise<number> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: await queueUrl(sqs, queueName),
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return (
    Number(Attributes?.ApproximateNumberOfMessages ?? 0) +
    Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
  );
}

export async function eventually<T>(
  probe: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await probe();
  while (!accept(last)) {
    if (Date.now() > deadline)
      throw new Error(`condition not met in ${timeoutMs}ms, last value: ${JSON.stringify(last)}`);
    await Bun.sleep(100);
    last = await probe();
  }
  return last;
}
