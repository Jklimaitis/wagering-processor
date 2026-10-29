import { createHash } from 'node:crypto';
import { IsolationLevel, LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { InboxMessage } from '../../domain/inbox-message';
import { hashWagerPayload } from '../idempotency/wager-payload-hash';
import { InboxMessageMapper } from './inbox-message-mapper';
import { InboxMessageRecord } from './inbox-message-record';
import { PostgresWagerProcessor } from './postgres-wager-processor';
import type {
  PostgresWagerResult,
  ProcessWagerProps,
  WagerProcessingContext,
} from './postgres-wager-processor';

export interface InboxDelivery {
  consumerName: string;
  messageId: string;
}

export class InboxPayloadConflictError extends Error {
  readonly code = 'INBOX_PAYLOAD_CONFLICT';

  constructor() {
    super('O messageId já foi recebido com outro conteúdo.');
    this.name = 'InboxPayloadConflictError';
  }
}

export class PostgresInboxWagerProcessor {
  constructor(private readonly em: EntityManager) {}

  async process(
    delivery: InboxDelivery,
    props: ProcessWagerProps,
    context?: WagerProcessingContext,
  ): Promise<PostgresWagerResult> {
    const payloadHash = createHash('sha256')
      .update(JSON.stringify({
        idempotencyKey: props.idempotencyKey,
        payloadHash: hashWagerPayload(props),
      }), 'utf8')
      .digest('hex');

    const received = InboxMessage.receive({
      consumerName: delivery.consumerName,
      messageId: delivery.messageId,
      payloadHash,
    });

    return this.em.fork().transactional(async (em) => {
      await em.createQueryBuilder(InboxMessageRecord)
        .insert(InboxMessageMapper.toRecord(received))
        .onConflict(['consumerName', 'messageId'])
        .ignore()
        .execute();

      const record = await em.findOneOrFail(
        InboxMessageRecord,
        {
          consumerName: delivery.consumerName,
          messageId: delivery.messageId,
        },
        {
          lockMode: LockMode.PESSIMISTIC_WRITE,
          refresh: true,
        },
      );

      const inbox = InboxMessageMapper.toDomain(record);

      if (!inbox.matchesPayload(payloadHash)) {
        throw new InboxPayloadConflictError();
      }

      const processor = new PostgresWagerProcessor(em);

      const result = await processor.process(
        props,
        undefined,
        {
          correlationId:
            context?.correlationId ?? crypto.randomUUID(),
          causationId:
            context?.causationId ?? delivery.messageId,
        },
      );

      if (inbox.isProcessed() && !result.idempotentReplay) {
        throw new Error(
          'Inbox processada sem resultado financeiro anterior.',
        );
      }

      if (!inbox.isProcessed()) {
        inbox.markProcessed();
        record.processedAt = inbox.processedAt ?? null;
      }

      return result;
    }, {
      isolationLevel: IsolationLevel.READ_COMMITTED,
    });
  }
}