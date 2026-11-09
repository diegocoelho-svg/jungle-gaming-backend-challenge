import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { type BeforeApplicationShutdown, Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { type Env, QUEUE_VISIBILITY_TIMEOUT_MS } from "../../../core/config/env";
import { ENV, LOGGER } from "../../../core/core.module";
import { SQS_CLIENT } from "../../../core/messaging/sqs.client";
import type { Logger } from "../../../core/observability/logger";
import { runWithRequestContext } from "../../../core/observability/request-context";
import { InvalidCommandError, WalletNotFoundError } from "../../application/errors/application.error";
import { WAGERING_METRICS, type WageringMetrics } from "../../application/ports/wagering-metrics.port";
import { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import { DomainError } from "../../domain/errors/domain.error";
import { InvalidRequestError } from "../http/request-parsers";
import { parseWagerMessage, type WagerMessage } from "./wager-message.parser";

export const WAGER_CONSUMER_NAME = "wager-transactions";

const RECEIVE_BATCH_SIZE = 10;
const RECEIVE_WAIT_SECONDS = 3;
const RECEIVE_ERROR_PAUSE_MS = 1_000;
const RETRY_BASE_SECONDS = 2;
const RETRY_MAX_SECONDS = 300;
const VISIBILITY_EXTENSION_SECONDS = QUEUE_VISIBILITY_TIMEOUT_MS / 1_000;

export enum DeadLetterReason {
  InvalidMessage = "INVALID_MESSAGE",
  MessageIdReused = "MESSAGE_ID_REUSED",
  WalletNotFound = "WALLET_NOT_FOUND",
}

type Handling = "acknowledged" | "dead-lettered" | "retry";

export const retryDelaySeconds = (receiveCount: number): number =>
  Math.min(RETRY_MAX_SECONDS, RETRY_BASE_SECONDS * 2 ** Math.max(0, receiveCount - 1));

function permanentReason(error: unknown): DeadLetterReason | undefined {
  if (error instanceof WalletNotFoundError) return DeadLetterReason.WalletNotFound;
  if (error instanceof InvalidRequestError || error instanceof InvalidCommandError || error instanceof DomainError) {
    return DeadLetterReason.InvalidMessage;
  }
  return undefined;
}

@Injectable()
export class WagerTransactionsConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private loop?: Promise<void>;
  private readonly visibilityUpdates = new WeakMap<Message, Promise<void>>();
  private readonly decided = new WeakSet<Message>();
  private readonly extensionQueued = new WeakSet<Message>();
  private queueUrl = "";
  private deadLetterQueueUrl = "";

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(ProcessWagerTransactionUseCase) private readonly processTransaction: ProcessWagerTransactionUseCase,
    @Inject(WAGERING_METRICS) private readonly metrics: WageringMetrics,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.queueUrl = await this.urlOf(this.env.sqs.wagerQueue);
    this.deadLetterQueueUrl = await this.urlOf(this.env.sqs.wagerDlq);
    this.running = true;
    this.loop = this.poll();
    this.logger.info({ context: WAGER_CONSUMER_NAME }, "consumer started");
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.loop;
    this.logger.info({ context: WAGER_CONSUMER_NAME }, "consumer drained");
  }

  private async urlOf(queueName: string): Promise<string> {
    const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
    if (!QueueUrl) throw new Error(`Queue not found: ${queueName}`);
    return QueueUrl;
  }

  private async poll(): Promise<void> {
    while (this.running) {
      const messages = await this.receive();
      if (messages.length > 0) await this.processBatch(messages);
    }
  }

  private async receive(): Promise<Message[]> {
    try {
      const { Messages } = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: RECEIVE_BATCH_SIZE,
          WaitTimeSeconds: RECEIVE_WAIT_SECONDS,
          MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
        }),
      );
      return Messages ?? [];
    } catch (error) {
      if (this.running) {
        this.logger.warn({ err: error, context: WAGER_CONSUMER_NAME }, "receive failed, pausing");
        await Bun.sleep(RECEIVE_ERROR_PAUSE_MS);
      }
      return [];
    }
  }

  private async processBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? "";
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }

    const unfinished = new Set(messages);
    const heartbeat = setInterval(() => {
      for (const message of unfinished) this.extend(message);
    }, this.env.sqs.visibilityHeartbeatMs);

    try {
      await Promise.all([...groups.values()].map((group) => this.processGroup(group, unfinished)));
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async processGroup(messages: Message[], unfinished: Set<Message>): Promise<void> {
    const release = async (remaining: Message[]) => {
      for (const message of remaining) unfinished.delete(message);
      await this.release(remaining);
    };

    for (const [index, message] of messages.entries()) {
      if (!this.running) {
        await release(messages.slice(index));
        return;
      }
      const handling = await this.handle(message);
      unfinished.delete(message);
      if (handling === "retry") {
        await release(messages.slice(index + 1));
        return;
      }
    }
  }

  async handle(message: Message): Promise<Handling> {
    let parsed: WagerMessage;
    try {
      parsed = parseWagerMessage(message.Body);
    } catch (error) {
      this.logger.warn({ err: error, messageId: message.MessageId }, "invalid wager message");
      return this.deadLetter(message, DeadLetterReason.InvalidMessage);
    }

    const context = {
      correlationId: parsed.correlationId ?? parsed.messageId,
      messageId: parsed.messageId,
      providerId: parsed.command.providerId,
      walletId: parsed.command.walletId,
    };
    return runWithRequestContext(context, () => this.settle(message, parsed, context.correlationId));
  }

  private async settle(message: Message, parsed: WagerMessage, correlationId: string): Promise<Handling> {
    const fields = {
      messageId: parsed.messageId,
      walletId: parsed.command.walletId,
      providerId: parsed.command.providerId,
    };

    try {
      const outcome = await this.processTransaction.executeFromMessage(
        parsed.command,
        { correlationId, causationId: parsed.messageId },
        { consumerName: WAGER_CONSUMER_NAME, messageId: parsed.messageId, receivedAt: new Date() },
      );

      switch (outcome.kind) {
        case "settled":
          this.logger.info(
            { ...fields, transactionId: outcome.outcome.transaction.id, context: outcome.outcome.transaction.status },
            outcome.outcome.idempotentReplay ? "message replayed an existing transaction" : "message settled",
          );
          return this.acknowledge(message);
        case "duplicate-message":
          if (!outcome.samePayload) {
            this.logger.warn(fields, "message id reused with a different payload");
            return this.deadLetter(message, DeadLetterReason.MessageIdReused);
          }
          this.logger.info(fields, "duplicate message acknowledged");
          return this.acknowledge(message);
        case "idempotency-conflict":
          this.logger.warn({ ...fields, context: "IDEMPOTENCY_CONFLICT" }, outcome.reason);
          return this.acknowledge(message);
      }
    } catch (error) {
      const reason = permanentReason(error);
      if (reason) {
        this.logger.warn({ ...fields, err: error, context: reason }, "permanent message failure");
        return this.deadLetter(message, reason);
      }
      return this.retryLater(message, error, fields);
    }
  }

  private async acknowledge(message: Message): Promise<Handling> {
    this.decided.add(message);
    await this.visibilityUpdates.get(message);
    try {
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }));
    } catch (error) {
      this.logger.warn({ err: error, messageId: message.MessageId }, "ack failed, message will be redelivered");
    }
    return "acknowledged";
  }

  private async deadLetter(message: Message, reason: DeadLetterReason): Promise<Handling> {
    this.decided.add(message);
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.deadLetterQueueUrl,
          MessageBody: message.Body ?? "",
          MessageGroupId: message.Attributes?.MessageGroupId ?? "dead-letter",
          MessageDeduplicationId: message.MessageId,
          MessageAttributes: { reason: { DataType: "String", StringValue: reason } },
        }),
      );
    } catch (error) {
      this.logger.error(
        { err: error, messageId: message.MessageId },
        "dead-letter failed, message will be redelivered",
      );
      return "retry";
    }
    this.metrics.deadLettered(reason);
    await this.acknowledge(message);
    return "dead-lettered";
  }

  private async retryLater(message: Message, error: unknown, fields: Record<string, string>): Promise<Handling> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
    const delay = retryDelaySeconds(receiveCount);
    this.logger.warn({ ...fields, err: error, context: `retry-in-${delay}s` }, "transient message failure");
    this.metrics.retried("message");
    await this.changeVisibility(message, delay);
    return "retry";
  }

  private async release(messages: Message[]): Promise<void> {
    await Promise.all(messages.map((message) => this.changeVisibility(message, 0)));
  }

  private extend(message: Message): void {
    if (this.decided.has(message) || this.extensionQueued.has(message)) return;
    this.extensionQueued.add(message);
    this.enqueueVisibility(message, async () => {
      this.extensionQueued.delete(message);
      await this.sendVisibility(message, VISIBILITY_EXTENSION_SECONDS);
    });
  }

  private changeVisibility(message: Message, seconds: number): Promise<void> {
    this.decided.add(message);
    return this.enqueueVisibility(message, () => this.sendVisibility(message, seconds));
  }

  private enqueueVisibility(message: Message, update: () => Promise<void>): Promise<void> {
    const previous = this.visibilityUpdates.get(message) ?? Promise.resolve();
    const next = previous.then(update);
    this.visibilityUpdates.set(message, next);
    return next;
  }

  private async sendVisibility(message: Message, seconds: number): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: seconds,
        }),
      );
    } catch (error) {
      this.logger.warn({ err: error, messageId: message.MessageId }, "visibility change failed");
    }
  }
}
