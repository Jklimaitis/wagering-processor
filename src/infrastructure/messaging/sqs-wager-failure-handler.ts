import { createHash } from "node:crypto";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import {
  decideSqsFailure,
  type SqsFailureDecision,
} from "./sqs-wager-failure-policy";

export class SqsWagerFailureHandler {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly dlqUrl: string,
  ) {
    if (queueUrl === dlqUrl) {
      throw new Error("Fila principal e DLQ devem ser diferentes.");
    }
  }

  async handle(message: Message, error: unknown): Promise<SqsFailureDecision> {
    const receiptHandle = message.ReceiptHandle;

    if (!receiptHandle) {
      throw new Error("Mensagem recebida sem ReceiptHandle.");
    }

    const decision = decideSqsFailure(
      error,
      message.Attributes?.ApproximateReceiveCount,
    );

    if (decision.action === "RETRY") {
      await this.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: decision.delaySeconds,
        }),
        {
          abortSignal: AbortSignal.timeout(10_000),
        },
      );

      return decision;
    }

    if (message.Body === undefined || !message.MessageId) {
      throw new Error("Mensagem sem corpo ou identificador de transporte.");
    }

    const deduplicationId = createHash("sha256")
      .update(JSON.stringify([this.queueUrl, message.MessageId]))
      .digest("hex");

    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.dlqUrl,
        MessageBody: message.Body,
        MessageGroupId: message.Attributes?.MessageGroupId ?? "wager-dlq",
        MessageDeduplicationId: deduplicationId,
        MessageAttributes: {
          failureReason: {
            DataType: "String",
            StringValue: decision.reason,
          },
          sourceMessageId: {
            DataType: "String",
            StringValue: message.MessageId,
          },
          receiveCount: {
            DataType: "Number",
            StringValue: String(decision.attempt),
          },
        },
      }),
      {
        abortSignal: AbortSignal.timeout(10_000),
      },
    );

    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
      }),
      {
        abortSignal: AbortSignal.timeout(10_000),
      },
    );

    return decision;
  }
}
