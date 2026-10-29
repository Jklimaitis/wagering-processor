import { setTimeout as delay } from "node:timers/promises";
import {
  ChangeMessageVisibilityCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { SqsWagerFailureHandler } from "./sqs-wager-failure-handler";
import type { SqsFailureDecision } from "./sqs-wager-failure-policy";
import type {
  HandledWagerMessage,
  SqsWagerMessageHandler,
} from "./sqs-wager-message-handler";

export interface SqsWagerConsumerOptions {
  waitTimeSeconds?: number;
  visibilityTimeoutSeconds?: number;
}

export type SqsWagerPollResult =
  | { status: "IDLE" }
  | { status: "STOPPED" }
  | {
      status: "ACKNOWLEDGED";
      outcome: HandledWagerMessage;
      heartbeatErrorName: string | undefined;
    }
  | {
      status: "FAILURE_HANDLED";
      transportMessageId: string | undefined;
      decision: SqsFailureDecision;
      heartbeatErrorName: string | undefined;
    };

export class SqsWagerConsumer {
  private readonly waitTimeSeconds: number;
  private readonly visibilityTimeoutSeconds: number;

  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly messageHandler: Pick<SqsWagerMessageHandler, "handle">,
    private readonly failureHandler: Pick<SqsWagerFailureHandler, "handle">,
    options: SqsWagerConsumerOptions = {},
  ) {
    this.waitTimeSeconds = options.waitTimeSeconds ?? 10;
    this.visibilityTimeoutSeconds = options.visibilityTimeoutSeconds ?? 30;

    if (
      !Number.isInteger(this.waitTimeSeconds) ||
      this.waitTimeSeconds < 0 ||
      this.waitTimeSeconds > 20
    ) {
      throw new Error("Long polling deve estar entre 0 e 20 segundos.");
    }

    if (
      !Number.isInteger(this.visibilityTimeoutSeconds) ||
      this.visibilityTimeoutSeconds < 1 ||
      this.visibilityTimeoutSeconds > 43_200
    ) {
      throw new Error("Visibility timeout inválido.");
    }
  }

  async poll(signal?: AbortSignal): Promise<SqsWagerPollResult> {
    if (signal?.aborted) {
      return { status: "STOPPED" };
    }

    const receiveTimeout = AbortSignal.timeout(
      (this.waitTimeSeconds + 5) * 1_000,
    );

    let message: Message | undefined;

    try {
      const received = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: this.waitTimeSeconds,
          VisibilityTimeout: this.visibilityTimeoutSeconds,
          MessageSystemAttributeNames: [
            "ApproximateReceiveCount",
            "MessageGroupId",
          ],
        }),
        {
          abortSignal:
            signal === undefined
              ? receiveTimeout
              : AbortSignal.any([signal, receiveTimeout]),
        },
      );

      message = received.Messages?.[0];
    } catch (error: unknown) {
      if (signal?.aborted) {
        return { status: "STOPPED" };
      }

      throw error;
    }

    if (message === undefined) {
      return { status: signal?.aborted ? "STOPPED" : "IDLE" };
    }

    const receiptHandle = message.ReceiptHandle;

    if (!receiptHandle) {
      throw new Error("SQS retornou mensagem sem ReceiptHandle.");
    }

    if (signal?.aborted) {
      await this.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: 0,
        }),
        {
          abortSignal: AbortSignal.timeout(10_000),
        },
      );

      return { status: "STOPPED" };
    }

    const heartbeatStop = new AbortController();
    let heartbeatErrorName: string | undefined;

    const heartbeat = this.maintainVisibility(
      receiptHandle,
      heartbeatStop.signal,
    ).catch((error: unknown) => {
      heartbeatErrorName = error instanceof Error ? error.name : "UnknownError";
    });

    let outcome: HandledWagerMessage | undefined;
    let processingError: unknown;

    try {
      outcome = await this.messageHandler.handle(message);
    } catch (error: unknown) {
      processingError = error;
    } finally {
      heartbeatStop.abort();
      await heartbeat;
    }

    if (outcome !== undefined) {
      return {
        status: "ACKNOWLEDGED",
        outcome,
        heartbeatErrorName,
      };
    }

    const decision = await this.failureHandler.handle(message, processingError);

    return {
      status: "FAILURE_HANDLED",
      transportMessageId: message.MessageId,
      decision,
      heartbeatErrorName,
    };
  }

  private async maintainVisibility(
    receiptHandle: string,
    signal: AbortSignal,
  ): Promise<void> {
    const intervalMs = Math.floor((this.visibilityTimeoutSeconds * 1_000) / 3);

    try {
      while (!signal.aborted) {
        await delay(intervalMs, undefined, { signal });

        if (signal.aborted) {
          return;
        }

        await this.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: receiptHandle,
            VisibilityTimeout: this.visibilityTimeoutSeconds,
          }),
          {
            abortSignal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          },
        );
      }
    } catch (error: unknown) {
      if (!signal.aborted) {
        throw error;
      }
    }
  }
}
