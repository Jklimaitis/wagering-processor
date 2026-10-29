import {
  DeleteMessageCommand,
  type Message,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { InvalidInputError } from "../../application/input-validation";
import { parseWagerMessage } from "../../application/parse-wager-message";
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
  ) {}

  async handle(message: Message): Promise<HandledWagerMessage> {
    const receiptHandle = message.ReceiptHandle;

    if (!receiptHandle) {
      throw new InvalidInputError("ReceiptHandle");
    }

    const parsed = parseWagerMessage(message.Body);

    const result = await this.processor.process(
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
  }
}
