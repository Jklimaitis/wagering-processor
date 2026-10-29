import { LockMode, QueryOrder } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { EventPublisher } from "../../application/event-publisher";
import { OutboxMessageMapper } from "./outbox-message-mapper";
import { OutboxMessageRecord } from "./outbox-message-record";

export type OutboxPublishResult =
  | { status: "IDLE" }
  | { status: "PUBLISHED"; eventId: string }
  | {
      status: "RETRY_SCHEDULED";
      eventId: string;
      error: unknown;
    };

export class PostgresOutboxPublisher {
  constructor(
    private readonly em: EntityManager,
    private readonly publisher: EventPublisher,
  ) {}

  async publishNext(): Promise<OutboxPublishResult> {
    return this.em.fork().transactional<OutboxPublishResult>(async (em) => {
      const record = await em.findOne(
        OutboxMessageRecord,
        {
          publishedAt: null,
          $or: [
            { nextAttemptAt: null },
            { nextAttemptAt: { $lte: new Date() } },
          ],
        },
        {
          lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
          orderBy: {
            nextAttemptAt: QueryOrder.ASC_NULLS_FIRST,
            occurredAt: QueryOrder.ASC,
            id: QueryOrder.ASC,
          },
        },
      );

      if (record === null) {
        return { status: "IDLE" };
      }

      const message = OutboxMessageMapper.toDomain(record);

      try {
        await this.publisher.publish(message);
      } catch (error: unknown) {
        message.scheduleRetry(new Date());

        record.attempts = message.attempts;
        record.nextAttemptAt = message.nextAttemptAt ?? null;

        return {
          status: "RETRY_SCHEDULED",
          eventId: message.id,
          error,
        };
      }

      message.markPublished(new Date());

      record.publishedAt = message.publishedAt ?? null;
      record.nextAttemptAt = null;

      return {
        status: "PUBLISHED",
        eventId: message.id,
      };
    });
  }
}
