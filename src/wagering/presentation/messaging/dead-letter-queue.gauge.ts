import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { Inject, Injectable } from "@nestjs/common";
import { Gauge, type Registry } from "prom-client";
import type { Env } from "../../../core/config/env";
import { ENV } from "../../../core/core.module";
import { SQS_CLIENT } from "../../../core/messaging/sqs.client";
import { METRICS_REGISTRY } from "../../../core/observability/metrics";

@Injectable()
export class DeadLetterQueueGauge {
  private queueUrl?: string;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(ENV) private readonly env: Env,
    @Inject(METRICS_REGISTRY) registry: Registry,
  ) {
    const depth = () => this.depth();
    new Gauge({
      name: "wagering_dead_letter_queue_messages",
      help: "Messages currently in the dead-letter queue, including those redriven by SQS after the receive limit",
      registers: [registry],
      async collect() {
        const value = await depth();
        if (value !== undefined) this.set(value);
      },
    });
  }

  private async depth(): Promise<number | undefined> {
    try {
      this.queueUrl ??= (await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.env.sqs.wagerDlq }))).QueueUrl;
      const { Attributes } = await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.queueUrl,
          AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
        }),
      );
      return (
        Number(Attributes?.ApproximateNumberOfMessages ?? 0) +
        Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
      );
    } catch {
      return undefined;
    }
  }
}
