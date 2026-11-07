import { CreateQueueCommand, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { loadEnv } from "../src/core/config/env";
import { createSqsClient } from "../src/core/messaging/sqs.client";

const env = loadEnv({ ...process.env, APP_ROLE: "api" });
const sqs = createSqsClient(env);

const VISIBILITY_TIMEOUT_SECONDS = "30";

const createFifoQueue = async (name: string, attributes: Record<string, string> = {}): Promise<string> => {
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: "true",
        VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
        ...attributes,
      },
    }),
  );
  if (!QueueUrl) throw new Error(`Queue has no URL: ${name}`);
  return QueueUrl;
};

const dlqUrl = await createFifoQueue(env.sqs.wagerDlq);
const { Attributes } = await sqs.send(
  new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }),
);
if (!Attributes?.QueueArn) throw new Error("DLQ has no ARN");

await createFifoQueue(env.sqs.wagerQueue, {
  RedrivePolicy: JSON.stringify({
    deadLetterTargetArn: Attributes.QueueArn,
    maxReceiveCount: env.sqs.maxReceiveCount,
  }),
});
await createFifoQueue(env.sqs.eventsQueue);

console.log(JSON.stringify({ queues: [env.sqs.wagerQueue, env.sqs.wagerDlq, env.sqs.eventsQueue] }));
sqs.destroy();
