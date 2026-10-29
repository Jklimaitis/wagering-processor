import { GetQueueUrlCommand } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { PostgresInboxWagerProcessor } from "../../src/infrastructure/database/postgres-inbox-wager-processor";
import {
  createSqsClient,
  getSqsWagerQueueNames,
} from "../../src/infrastructure/messaging/sqs-client";
import { SqsWagerConsumer } from "../../src/infrastructure/messaging/sqs-wager-consumer";
import { SqsWagerFailureHandler } from "../../src/infrastructure/messaging/sqs-wager-failure-handler";
import { SqsWagerMessageHandler } from "../../src/infrastructure/messaging/sqs-wager-message-handler";

async function main(): Promise<void> {
  if (process.send === undefined) {
    throw new Error("Este helper precisa de um canal IPC.");
  }

  const client = createSqsClient();
  let orm: MikroORM | undefined;

  try {
    const { queueName, dlqName } = getSqsWagerQueueNames();

    const [queue, dlq] = await Promise.all([
      client.send(new GetQueueUrlCommand({ QueueName: queueName })),
      client.send(new GetQueueUrlCommand({ QueueName: dlqName })),
    ]);

    if (queue.QueueUrl === undefined || dlq.QueueUrl === undefined) {
      throw new Error("Filas de teste não encontradas.");
    }

    orm = await MikroORM.init(config);
    await orm.connect();

    client.middlewareStack.add(
      (next, context) => async (args) => {
        if (context.commandName === "DeleteMessageCommand") {
          process.send?.("before-ack");

          // O processo pai vai encerrar este processo com SIGKILL.
          await new Promise<void>(() => {});
        }

        return next(args);
      },
      {
        step: "initialize",
        name: "pauseBeforeAcknowledgement",
      },
    );

    const consumer = new SqsWagerConsumer(
      client,
      queue.QueueUrl,
      new SqsWagerMessageHandler(
        client,
        queue.QueueUrl,
        new PostgresInboxWagerProcessor(orm.em),
      ),
      new SqsWagerFailureHandler(client, queue.QueueUrl, dlq.QueueUrl),
      {
        waitTimeSeconds: 1,
        visibilityTimeoutSeconds: 2,
      },
    );

    await consumer.poll();

    throw new Error("Helper terminou sem pausar antes do ack.");
  } finally {
    try {
      if (orm !== undefined) {
        await orm.close(true);
      }
    } finally {
      client.destroy();
    }
  }
}

main()
  .catch((error: unknown) => {
    console.error(
      JSON.stringify({
        event: "before_ack_worker_failed",
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
    );

    process.exitCode = 1;
  })
  .finally(() => {
    process.disconnect?.();
  });
