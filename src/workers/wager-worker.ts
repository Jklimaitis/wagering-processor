import { setTimeout as delay } from "node:timers/promises";
import { GetQueueUrlCommand } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../infrastructure/database/mikro-orm.config";
import { PostgresInboxWagerProcessor } from "../infrastructure/database/postgres-inbox-wager-processor";
import {
  createSqsClient,
  getSqsWagerQueueNames,
} from "../infrastructure/messaging/sqs-client";
import { SqsWagerConsumer } from "../infrastructure/messaging/sqs-wager-consumer";
import { SqsWagerFailureHandler } from "../infrastructure/messaging/sqs-wager-failure-handler";
import { SqsWagerMessageHandler } from "../infrastructure/messaging/sqs-wager-message-handler";
import { MetricsService } from "../metrics.service";
import { startWorkerMetrics } from "./worker-metrics";

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
      service: "wager-consumer",
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

  log("info", "wager_worker_stopping");
  shutdown.abort();
}

async function pause(): Promise<void> {
  try {
    await delay(1_000, undefined, {
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
  const metrics = new MetricsService();
  let metricsServer: ReturnType<typeof startWorkerMetrics> | undefined;
  let orm: MikroORM | undefined;

  try {
    const { queueName, dlqName } = getSqsWagerQueueNames();

    const [queue, dlq] = await Promise.all([
      client.send(new GetQueueUrlCommand({ QueueName: queueName }), {
        abortSignal: AbortSignal.timeout(10_000),
      }),
      client.send(new GetQueueUrlCommand({ QueueName: dlqName }), {
        abortSignal: AbortSignal.timeout(10_000),
      }),
    ]);

    if (queue.QueueUrl === undefined || dlq.QueueUrl === undefined) {
      throw new Error("SQS não retornou as URLs das filas.");
    }

    orm = await MikroORM.init(config);
    await orm.connect();

    const consumer = new SqsWagerConsumer(
      client,
      queue.QueueUrl,
      new SqsWagerMessageHandler(
        client,
        queue.QueueUrl,
        new PostgresInboxWagerProcessor(orm.em),
        metrics,
      ),
      new SqsWagerFailureHandler(client, queue.QueueUrl, dlq.QueueUrl, metrics),
    );

    metricsServer = startWorkerMetrics(metrics);
    log("info", "wager_worker_ready", { queueName, dlqName, metricsPort: metricsServer.port });

    while (!shutdown.signal.aborted) {
      try {
        const result = await consumer.poll(shutdown.signal);

        if (result.status === "STOPPED") {
          break;
        }

        if (result.status === "IDLE") {
          continue;
        }

        if (result.heartbeatErrorName !== undefined) {
          log("warn", "wager_heartbeat_failed", {
            errorName: result.heartbeatErrorName,
          });
        }

        if (result.status === "ACKNOWLEDGED") {
          const { outcome } = result;

          log("info", "wager_message_acknowledged", {
            correlationId: outcome.correlationId,
            messageId: outcome.messageId,
            transactionId: outcome.result.transactionId,
            walletId: outcome.walletId,
            providerId: outcome.providerId,
            status: outcome.result.status,
            idempotentReplay: outcome.result.idempotentReplay,
          });
        } else {
          log("warn", "wager_delivery_failure_handled", {
            transportMessageId: result.transportMessageId,
            action: result.decision.action,
            attempt: result.decision.attempt,
            reason: result.decision.reason,
          });
        }
      } catch (error: unknown) {
        log("error", "wager_iteration_failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });

        await pause();
      }
    }
  } finally {
    try {
      await metricsServer?.stop(true);
    } finally {
      try {
        if (orm !== undefined) await orm.close(true);
      } finally {
        client.destroy();
      }
    }
  }

  log("info", "wager_worker_stopped");
}

process.on("SIGTERM", requestShutdown);
process.on("SIGINT", requestShutdown);

main()
  .catch((error: unknown) => {
    log("error", "wager_worker_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });

    process.exitCode = 1;
  })
  .finally(() => {
    process.off("SIGTERM", requestShutdown);
    process.off("SIGINT", requestShutdown);
  });
