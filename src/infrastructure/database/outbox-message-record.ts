import { EntitySchema } from "@mikro-orm/core";

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date | null;
  publishedAt!: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: "outbox_messages",
  schema: "*",

  properties: {
    id: {
      type: "uuid",
      primary: true,
    },
    aggregateId: {
      type: "uuid",
      fieldName: "aggregate_id",
    },
    eventType: {
      type: "text",
      fieldName: "event_type",
    },
    payload: {
      type: "json",
      columnType: "jsonb",
    },
    occurredAt: {
      type: Date,
      columnType: "timestamptz",
      fieldName: "occurred_at",
    },
    attempts: {
      type: "integer",
      default: 0,
    },
    nextAttemptAt: {
      type: Date,
      columnType: "timestamptz",
      fieldName: "next_attempt_at",
      nullable: true,
    },
    publishedAt: {
      type: Date,
      columnType: "timestamptz",
      fieldName: "published_at",
      nullable: true,
    },
  },

  indexes: [
    {
      name: "outbox_messages_pending_idx",
      properties: ["nextAttemptAt", "occurredAt", "id"],
      where: "published_at is null",
    },
  ],

  checks: [
    {
      name: "outbox_messages_attempts_nonnegative",
      expression: "attempts >= 0",
    },
    {
      name: "outbox_messages_event_type_required",
      expression: "length(trim(event_type)) > 0",
    },
    {
      name: "outbox_messages_payload_envelope",
      expression: `
          jsonb_typeof(payload) = 'object'
          and payload @> jsonb_build_object(
            'eventId', id::text,
            'aggregateId', aggregate_id::text,
            'eventType', event_type
          )
        `,
    },
    {
      name: "outbox_messages_published_schedule_consistent",
      expression: `
          published_at is null or next_attempt_at is null
        `,
    },
  ],
});
