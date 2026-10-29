import { setTimeout as delay } from "node:timers/promises";
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  QueueDoesNotExist,
  SetQueueAttributesCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import {
  createSqsClient,
  getSqsWagerQueueNames,
} from "../infrastructure/messaging/sqs-client";
import { MAX_SQS_ATTEMPTS } from "../infrastructure/messaging/sqs-wager-failure-policy";

function requestOptions() {
  return {
    abortSignal: AbortSignal.timeout(10_000),
  };
}

async function ensureQueue(client: SQSClient, name: string) {
  let url: string | undefined;

  try {
    const existing = await client.send(
      new GetQueueUrlCommand({ QueueName: name }),
      requestOptions(),
    );

    url = existing.QueueUrl;
  } catch (error: unknown) {
    if (!(error instanceof QueueDoesNotExist)) {
      throw error;
    }

    const created = await client.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "false",
        },
      }),
      requestOptions(),
    );

    url = created.QueueUrl;
    await delay(1_000);
  }

  if (url === undefined) {
    throw new Error(`SQS não retornou a URL de ${name}.`);
  }

  const response = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ["QueueArn", "FifoQueue"],
    }),
    requestOptions(),
  );

  const arn = response.Attributes?.QueueArn;

  if (response.Attributes?.FifoQueue !== "true" || arn === undefined) {
    throw new Error(`A fila ${name} precisa ser FIFO e possuir ARN.`);
  }

  return { url, arn };
}

async function main(): Promise<void> {
  const client = createSqsClient();

  try {
    const { queueName, dlqName } = getSqsWagerQueueNames();

    const dlq = await ensureQueue(client, dlqName);
    const queue = await ensureQueue(client, queueName);

    await client.send(
      new SetQueueAttributesCommand({
        QueueUrl: dlq.url,
        Attributes: {
          ContentBasedDeduplication: "false",
          MessageRetentionPeriod: "1209600",
        },
      }),
      requestOptions(),
    );

    await client.send(
      new SetQueueAttributesCommand({
        QueueUrl: queue.url,
        Attributes: {
          ContentBasedDeduplication: "false",
          VisibilityTimeout: "30",
          ReceiveMessageWaitTimeSeconds: "10",
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlq.arn,
            maxReceiveCount: MAX_SQS_ATTEMPTS,
          }),
        },
      }),
      requestOptions(),
    );

    console.log(
      JSON.stringify({
        event: "wager_queues_ready",
        queueName,
        dlqName,
        maxAttempts: MAX_SQS_ATTEMPTS,
      }),
    );
  } finally {
    client.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "wager_queues_setup_failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }),
  );

  process.exitCode = 1;
});
