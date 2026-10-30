import { setTimeout as delay } from "node:timers/promises";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../infrastructure/database/mikro-orm.config";
import { PostgresWagerProcessor } from "../infrastructure/database/postgres-wager-processor";
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
      service: "reference-worker",
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

  log("info", "reference_worker_stopping");
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
  let orm: MikroORM | undefined;
  const metrics = new MetricsService();
  let metricsServer: ReturnType<typeof startWorkerMetrics> | undefined;

  try {
    orm = await MikroORM.init(config);
    await orm.connect();

    const processor = new PostgresWagerProcessor(orm.em);
    metricsServer = startWorkerMetrics(metrics);

    log("info", "reference_worker_ready", { metricsPort: metricsServer.port });

    while (!shutdown.signal.aborted) {
      let pauseMs = 500;
      const startedAt = performance.now();

      try {
        const result = await processor.reprocessNextPendingReference();

        if (result.status !== "IDLE") {
          metrics.observeDuration("reference", performance.now() - startedAt);
          const context = {
            correlationId: result.correlationId,
            transactionId: result.transactionId,
            walletId: result.walletId,
            providerId: result.providerId,
            attempts: result.attempts,
            messageId: result.messageId,
          };

          if (result.status === "RESCHEDULED") {
            metrics.recordRetry("reference");
            log("info", "reference_rescheduled", {
              ...context,
              nextAttemptAt: result.nextAttemptAt.toISOString(),
            });
          } else {
            metrics.recordWagerResult("reference", result.result);
            log("info", "reference_completed", {
              ...context,
              status: result.result.status,
              failureCode: result.result.failureCode,
            });
          }

          pauseMs = 0;
        }
      } catch (error: unknown) {
        metrics.recordLockConflict("reference", error);
        log("error", "reference_iteration_failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });

        pauseMs = 1_000;
      }

      if (pauseMs > 0 && !shutdown.signal.aborted) {
        await pause(pauseMs);
      }
    }
  } finally {
    try { await metricsServer?.stop(true); }
    finally { if (orm !== undefined) await orm.close(true); }
  }

  log("info", "reference_worker_stopped");
}

process.on("SIGTERM", requestShutdown);
process.on("SIGINT", requestShutdown);

main()
  .catch((error: unknown) => {
    log("error", "reference_worker_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });

    process.exitCode = 1;
  })
  .finally(() => {
    process.off("SIGTERM", requestShutdown);
    process.off("SIGINT", requestShutdown);
  });
