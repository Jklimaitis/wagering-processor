import { setTimeout as delay } from "node:timers/promises";
import { GetQueueUrlCommand } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../infrastructure/database/mikro-orm.config";
import { PostgresOutboxPublisher } from "../infrastructure/database/postgres-outbox-publisher";
import {
  createSqsClient,
  getSqsEventsQueueName,
} from "../infrastructure/messaging/sqs-client";
import { SqsEventPublisher } from "../infrastructure/messaging/sqs-event-publisher";

const shutdown = new AbortController();

function log(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
): void {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      service: "outbox-worker",
      pid: process.pid,
      event,
      ...fields,
    }),
  );
}

function requestShutdown(): void {
  if (shutdown.signal.aborted) {
    return;
  }

  log("info", "outbox_worker_stopping");
  shutdown.abort();
}

async function pause(milliseconds: number): Promise<void> {
  try {
    await delay(milliseconds, undefined, {
      signal: shutdown.signal,
    });
  } catch (error: unknown) {
    if (!shutdown.signal.aborted) {
      throw error;
    }
  }
}

async function main(): Promise<void> {
  const client = createSqsClient();
  let orm: MikroORM | undefined;

  try {
    const queueName = getSqsEventsQueueName();

    const { QueueUrl } = await client.send(
      new GetQueueUrlCommand({
        QueueName: queueName,
      }),
      {
        abortSignal: AbortSignal.timeout(10_000),
      },
    );

    if (QueueUrl === undefined) {
      throw new Error("SQS não retornou a URL da fila de eventos.");
    }

    orm = await MikroORM.init(config);
    await orm.connect();

    const publisher = new PostgresOutboxPublisher(
      orm.em,
      new SqsEventPublisher(client, QueueUrl),
    );

    log("info", "outbox_worker_ready", { queueName });

    while (!shutdown.signal.aborted) {
      let pauseMs = 500;

      try {
        const result = await publisher.publishNext();

        if (result.status === "PUBLISHED") {
          log("info", "outbox_event_published", {
            eventId: result.eventId,
          });

          pauseMs = 0;
        } else if (result.status === "RETRY_SCHEDULED") {
          log("warn", "outbox_retry_scheduled", {
            eventId: result.eventId,
            errorName:
              result.error instanceof Error
                ? result.error.name
                : "UnknownError",
          });
        }
      } catch (error: unknown) {
        log("error", "outbox_iteration_failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });

        pauseMs = 1_000;
      }

      if (pauseMs > 0 && !shutdown.signal.aborted) {
        await pause(pauseMs);
      }
    }
  } finally {
    try {
      if (orm !== undefined) {
        await orm.close(true);
      }
    } finally {
      client.destroy();
    }
  }

  log("info", "outbox_worker_stopped");
}

process.on("SIGTERM", requestShutdown);
process.on("SIGINT", requestShutdown);

main()
  .catch((error: unknown) => {
    log("error", "outbox_worker_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });

    process.exitCode = 1;
  })
  .finally(() => {
    process.off("SIGTERM", requestShutdown);
    process.off("SIGINT", requestShutdown);
  });
