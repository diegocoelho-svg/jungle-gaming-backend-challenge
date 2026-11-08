import { SQSClient } from "@aws-sdk/client-sqs";
import { type Env, SQS_REQUEST_TIMEOUT_MS } from "../config/env";

export const SQS_CLIENT = Symbol("SQS_CLIENT");

export const createSqsClient = (env: Pick<Env, "aws" | "sqs">): SQSClient =>
  new SQSClient({
    region: env.aws.region,
    endpoint: env.sqs.endpoint,
    credentials: {
      accessKeyId: env.aws.accessKeyId,
      secretAccessKey: env.aws.secretAccessKey,
    },
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 1_000, requestTimeout: SQS_REQUEST_TIMEOUT_MS },
  });
