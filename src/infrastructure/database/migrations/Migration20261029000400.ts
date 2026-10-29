import { Migration } from "@mikro-orm/migrations";

export class Migration20261029000400 extends Migration {
  override up(): void {
    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz,
        published_at timestamptz,

        constraint outbox_messages_attempts_nonnegative
          check (attempts >= 0),

        constraint outbox_messages_event_type_required
          check (length(trim(event_type)) > 0),

        constraint outbox_messages_payload_envelope
          check (
            jsonb_typeof(payload) = 'object'
            and payload @> jsonb_build_object(
              'eventId', id::text,
              'aggregateId', aggregate_id::text,
              'eventType', event_type
            )
          ),

        constraint outbox_messages_published_schedule_consistent
          check (
            published_at is null or next_attempt_at is null
          )
      );
    `);

    this.addSql(`
      create index outbox_messages_pending_idx
      on outbox_messages (next_attempt_at, occurred_at, id)
      where published_at is null;
    `);
  }

  override down(): void {
    this.addSql("drop table outbox_messages;");
  }
}
