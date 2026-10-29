import { setTimeout as delay } from "node:timers/promises";
import { CreateQueueCommand } from "@aws-sdk/client-sqs";
import {
  createSqsClient,
  getSqsEventsQueueName,
} from "../infrastructure/messaging/sqs-client";

async function main(): Promise<void> {
  const client = createSqsClient();

  try {
    const queueName = getSqsEventsQueueName();

    await client.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "false",
        },
      }),
      {
        abortSignal: AbortSignal.timeout(10_000),
      },
    );

    await delay(1_000);

    console.log(
      JSON.stringify({
        event: "events_queue_ready",
        queueName,
      }),
    );
  } finally {
    client.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "events_queue_setup_failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }),
  );

  process.exitCode = 1;
});
