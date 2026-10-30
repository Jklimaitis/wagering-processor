import { DeadlockException, LockWaitTimeoutException } from "@mikro-orm/core";
import { Injectable } from "@nestjs/common";
import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { SqsFailureDecision } from "./infrastructure/messaging/sqs-wager-failure-policy";
import { WagerTransactionStatus } from "./domain/wager-transaction";
import type { PostgresWagerResult } from "./infrastructure/database/postgres-wager-processor";

export type ProcessingSource = "http" | "sqs" | "reference" | "outbox";

@Injectable()
export class MetricsService {
  private readonly registry = new Registry();

  private readonly reconciliations = new Counter<"result">({
    name: "wagering_reconciliations_total",
    help: "Wallet reconciliations by consistency result",
    labelNames: ["result"],
    registers: [this.registry],
  });

  private readonly wagerResults = new Counter<"source" | "status">({
    name: "wagering_transaction_results_total",
    help: "Non-replay wager processing results by source and status",
    labelNames: ["source", "status"],
    registers: [this.registry],
  });

  private readonly duplicates = new Counter<"source">({
    name: "wagering_duplicates_total",
    help: "Idempotent wager replays by source",
    labelNames: ["source"],
    registers: [this.registry],
  });

  private readonly lockConflicts = new Counter<"source">({
    name: "wagering_lock_conflicts_total",
    help: "Database lock conflicts and serialization failures",
    labelNames: ["source"],
    registers: [this.registry],
  });

  private readonly processingDuration = new Histogram<"source">({
    name: "wagering_processing_duration_seconds",
    help: "Processing duration by source",
    labelNames: ["source"],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
    registers: [this.registry],
  });

  private readonly retries = new Counter<"source">({
    name: "wagering_retries_total",
    help: "Confirmed retry schedules by source",
    labelNames: ["source"],
    registers: [this.registry],
  });

  private readonly deadLetters = new Counter<"reason">({
    name: "wagering_dlq_messages_total",
    help: "Completed SQS dead-letter deliveries by reason",
    labelNames: ["reason"],
    registers: [this.registry],
  });

  private readonly outboxLag = new Gauge({
    name: "wagering_outbox_lag_seconds",
    help: "Age of the oldest unpublished outbox event, zero when empty",
    registers: [this.registry],
  });

  constructor() {
    this.reconciliations.labels("consistent").inc(0);
    this.reconciliations.labels("inconsistent").inc(0);

    for (const source of ["http", "sqs", "reference"] as const) {
      this.duplicates.labels(source).inc(0);

      for (const status of Object.values(WagerTransactionStatus)) {
        this.wagerResults.labels(source, status).inc(0);
      }
    }

    for (const source of ["http", "sqs", "reference", "outbox"] as const) {
      this.lockConflicts.labels(source).inc(0);
    }
    for (const source of ["sqs", "reference", "outbox"] as const) {
      this.retries.labels(source).inc(0);
    }
  }

  recordReconciliation(consistent: boolean): void {
    this.reconciliations
      .labels(consistent ? "consistent" : "inconsistent")
      .inc();
  }

  recordWagerResult(
    source: Exclude<ProcessingSource, "outbox">,
    result: Pick<PostgresWagerResult, "status" | "idempotentReplay">,
  ): void {
    if (result.idempotentReplay) {
      this.duplicates.labels(source).inc();
      return;
    }

    this.wagerResults.labels(source, result.status).inc();
  }

  recordLockConflict(source: ProcessingSource, error: unknown): void {
    const code =
      error instanceof Error && "code" in error ? error.code : undefined;

    if (
      error instanceof DeadlockException ||
      error instanceof LockWaitTimeoutException ||
      (typeof code === "string" && ["40001", "40P01", "55P03"].includes(code))
    ) {
      this.lockConflicts.labels(source).inc();
    }
  }

  startProcessing(source: ProcessingSource): () => void {
    const startedAt = performance.now();

    return () => {
      this.observeDuration(source, performance.now() - startedAt);
    };
  }

  observeDuration(source: ProcessingSource, milliseconds: number): void {
    this.processingDuration.observe({ source }, milliseconds / 1_000);
  }

  recordRetry(source: Exclude<ProcessingSource, "http">): void {
    this.retries.labels(source).inc();
  }

  recordDlq(reason: Extract<SqsFailureDecision, { action: "DLQ" }>["reason"]): void {
    this.deadLetters.labels(reason).inc();
  }

  async refreshOutbox(em: EntityManager): Promise<void> {
    const namespace = em.getPlatform().quoteIdentifier(
      em.schema ?? em.config.get("schema") ?? "public",
    );
    const [row] = await em.fork().execute<{ lag: number }[]>(
      `select greatest(0, coalesce(extract(epoch from
        (now() - min(occurred_at))), 0))::double precision as lag
       from ${namespace}.outbox_messages where published_at is null`,
      [],
      { signal: AbortSignal.timeout(2_000), inflightQueryAbortStrategy: "cancel query" },
    );
    if (row === undefined || !Number.isFinite(row.lag)) {
      throw new Error("Não foi possível medir o atraso da outbox.");
    }
    this.outboxLag.set(row.lag);
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
