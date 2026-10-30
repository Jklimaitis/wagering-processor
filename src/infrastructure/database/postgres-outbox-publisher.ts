import { LockMode, QueryOrder } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { EventPublisher } from "../../application/event-publisher";
import { OutboxMessageMapper } from "./outbox-message-mapper";
import { OutboxMessageRecord } from "./outbox-message-record";
import { WagerTransactionRecord } from "./wager-transaction-record";

interface OutboxContext {
  correlationId: string | null;
  messageId: string | null;
  transactionId: string | null;
  walletId: string | null;
  providerId: string | null;
}

export type OutboxPublishResult =
  | { status: "IDLE" }
  | ({ status: "PUBLISHED"; eventId: string } & OutboxContext)
  | ({
      status: "RETRY_SCHEDULED";
      eventId: string;
      error: unknown;
    } & OutboxContext);

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
      const payload = message.payload;
      const data = payload.data !== null && typeof payload.data === "object"
        ? payload.data as Record<string, unknown> : {};
      const text = (value: unknown) => typeof value === "string" ? value : null;
      const context: OutboxContext = {
        correlationId: text(payload.correlationId),
        messageId: text(payload.causationId),
        transactionId: text(data.transactionId),
        walletId: text(data.walletId),
        providerId: text(data.providerId),
      };
      if (context.providerId === null && context.transactionId !== null) {
        const transaction = await em.findOne(WagerTransactionRecord,
          { id: context.transactionId }, { fields: ["providerId"] });
        context.providerId = transaction?.providerId ?? null;
      }

      try {
        await this.publisher.publish(message);
      } catch (error: unknown) {
        message.scheduleRetry(new Date());

        record.attempts = message.attempts;
        record.nextAttemptAt = message.nextAttemptAt ?? null;

        return {
          status: "RETRY_SCHEDULED",
          eventId: message.id,
          ...context,
          error,
        };
      }

      message.markPublished(new Date());

      record.publishedAt = message.publishedAt ?? null;
      record.nextAttemptAt = null;

      return {
        status: "PUBLISHED",
        eventId: message.id,
        ...context,
      };
    });
  }
}
