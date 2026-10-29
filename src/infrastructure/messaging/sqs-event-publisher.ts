import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { EventPublisher } from "../../application/event-publisher";
import type { OutboxMessage } from "../../domain/outbox-message";

export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
      }),
      {
        abortSignal: AbortSignal.timeout(10_000),
      },
    );
  }
}
