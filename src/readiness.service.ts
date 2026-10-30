import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { DatabaseService } from "./infrastructure/database/database.service";

export interface ReadinessReport {
  status: "ok" | "error";
  checks: {
    postgres: "up" | "down";
    sqs: "up" | "down";
  };
}

@Injectable()
export class ReadinessService implements OnModuleDestroy {
  constructor(
    private readonly database: DatabaseService,
    private readonly sqs: SQSClient,
    private readonly queueNames: readonly string[],
  ) {}

  async check(): Promise<ReadinessReport> {
    const signal = AbortSignal.timeout(2_000);

    const [postgres, sqs] = await Promise.allSettled([
      this.checkPostgres(signal),
      this.checkSqs(signal),
    ]);

    const postgresUp = postgres.status === "fulfilled";
    const sqsUp = sqs.status === "fulfilled";

    return {
      status: postgresUp && sqsUp ? "ok" : "error",
      checks: {
        postgres: postgresUp ? "up" : "down",
        sqs: sqsUp ? "up" : "down",
      },
    };
  }

  private async checkPostgres(signal: AbortSignal): Promise<void> {
    await this.database.em.execute("select 1", [], {
      signal,
      inflightQueryAbortStrategy: "cancel query",
    });
  }

  private async checkSqs(signal: AbortSignal): Promise<void> {
    const queues = await Promise.all(
      this.queueNames.map((name) =>
        this.sqs.send(new GetQueueUrlCommand({ QueueName: name }), {
          abortSignal: signal,
        }),
      ),
    );

    if (queues.some((queue) => queue.QueueUrl === undefined)) {
      throw new Error("SQS não retornou todas as filas configuradas.");
    }
  }

  onModuleDestroy(): void {
    this.sqs.destroy();
  }
}
