import {
  DeleteMessageCommand,
  type Message,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { InvalidInputError } from "../../application/input-validation";
import { parseWagerMessage, type ParsedWagerMessage } from "../../application/parse-wager-message";
import type { MetricsService } from "../../metrics.service";
import type { PostgresInboxWagerProcessor } from "../database/postgres-inbox-wager-processor";
import type { PostgresWagerResult } from "../database/postgres-wager-processor";

export const WAGER_CONSUMER_NAME = "wager-consumer";

export interface HandledWagerMessage {
  messageId: string;
  correlationId: string;
  walletId: string;
  providerId: string;
  result: PostgresWagerResult;
}

export class SqsAcknowledgementError extends Error {
  constructor(
    readonly outcome: HandledWagerMessage,
    cause: unknown,
  ) {
    super("Falha no ack após confirmar o processamento.", { cause });
    this.name = "SqsAcknowledgementError";
  }
}

export class SqsWagerMessageHandler {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly processor: Pick<PostgresInboxWagerProcessor, "process">,
    private readonly metrics?: Pick<MetricsService,
      "startProcessing" | "recordWagerResult" | "recordLockConflict">,
  ) {}

  async handle(message: Message): Promise<HandledWagerMessage> {
    const finish = this.metrics?.startProcessing("sqs");
    let parsed: ParsedWagerMessage | undefined;
    let result: PostgresWagerResult | undefined;
    try {
      const receiptHandle = message.ReceiptHandle;

      if (!receiptHandle) {
        throw new InvalidInputError("ReceiptHandle");
      }

      parsed = parseWagerMessage(message.Body);

      result = await this.processor.process(
        {
          consumerName: WAGER_CONSUMER_NAME,
          messageId: parsed.messageId,
        },
        {
          ...parsed.data,
          id: crypto.randomUUID(),
        },
        {
          correlationId: parsed.correlationId,
          causationId: parsed.messageId,
        },
      );

      this.metrics?.recordWagerResult("sqs", result);
      const outcome: HandledWagerMessage = {
        messageId: parsed.messageId,
        correlationId: parsed.correlationId,
        walletId: parsed.data.walletId,
        providerId: parsed.data.providerId,
        result,
      };

      try {
        await this.client.send(
          new DeleteMessageCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: receiptHandle,
          }),
          {
            abortSignal: AbortSignal.timeout(10_000),
          },
        );
      } catch (error: unknown) {
        throw new SqsAcknowledgementError(outcome, error);
      }

      return outcome;
    } catch (error: unknown) {
      this.metrics?.recordLockConflict("sqs", error);
      console.log(JSON.stringify({
        timestamp: new Date().toISOString(), level: "warn", service: "wager-consumer",
        event: "wager_message_processing_failed", pid: process.pid,
        correlationId: parsed?.correlationId ?? message.MessageId ?? crypto.randomUUID(),
        messageId: parsed?.messageId ?? null, transportMessageId: message.MessageId ?? null,
        transactionId: result?.transactionId ?? null, walletId: parsed?.data.walletId ?? null,
        providerId: parsed?.data.providerId ?? null, committed: result !== undefined,
        errorName: error instanceof Error ? error.name : "UnknownError",
      }));
      throw error;
    } finally {
      finish?.();
    }
  }
}
