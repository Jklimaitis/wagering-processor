import { InboxMessage } from "../../domain/inbox-message";
import { InboxMessageRecord } from "./inbox-message-record";

export class InboxMessageMapper {
  static toDomain(record: InboxMessageRecord): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: record.consumerName,
      messageId: record.messageId,
      payloadHash: record.payloadHash,
      receivedAt: record.receivedAt,
      processedAt: record.processedAt ?? undefined,
    });
  }

  static toRecord(message: InboxMessage): InboxMessageRecord {
    const record = new InboxMessageRecord();

    record.consumerName = message.consumerName;
    record.messageId = message.messageId;
    record.payloadHash = message.payloadHash;
    record.receivedAt = message.receivedAt;
    record.processedAt = message.processedAt ?? null;

    return record;
  }
}
