import { OutboxMessage } from "../../domain/outbox-message";
import { OutboxMessageRecord } from "./outbox-message-record";

export class OutboxMessageMapper {
  static toDomain(record: OutboxMessageRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: record.id,
      aggregateId: record.aggregateId,
      eventType: record.eventType,
      payload: record.payload,
      occurredAt: record.occurredAt,
      attempts: record.attempts,
      nextAttemptAt: record.nextAttemptAt ?? undefined,
      publishedAt: record.publishedAt ?? undefined,
    });
  }

  static toRecord(message: OutboxMessage): OutboxMessageRecord {
    const record = new OutboxMessageRecord();

    record.id = message.id;
    record.aggregateId = message.aggregateId;
    record.eventType = message.eventType;
    record.payload = { ...message.payload };
    record.occurredAt = message.occurredAt;
    record.attempts = message.attempts;
    record.nextAttemptAt = message.nextAttemptAt ?? null;
    record.publishedAt = message.publishedAt ?? null;

    return record;
  }
}
