import { Migration } from "@mikro-orm/migrations";

export class Migration20261029000600 extends Migration {
  override up(): void {
    this.addSql(`
      alter table wager_transactions
        add column reference_attempts integer not null default 0,
        add column next_reference_attempt_at timestamptz,
        add column correlation_id text,
        add column causation_id text,

        add constraint wager_transactions_reference_attempts_nonnegative
          check (reference_attempts >= 0),

        add constraint wager_transactions_reference_schedule_consistent
          check (
            next_reference_attempt_at is null
            or status = 'PENDING_REFERENCE'
          ),

        add constraint wager_transactions_trace_identifiers_nonempty
          check (
            (correlation_id is null or length(trim(correlation_id)) > 0)
            and
            (causation_id is null or length(trim(causation_id)) > 0)
          )
    `);

    this.addSql(`
      create index wager_transactions_reference_due_idx
      on wager_transactions (next_reference_attempt_at, created_at, id)
      where status = 'PENDING_REFERENCE'
    `);
  }

  override down(): void {
    this.addSql("drop index wager_transactions_reference_due_idx");

    this.addSql(`
      alter table wager_transactions
        drop constraint wager_transactions_reference_attempts_nonnegative,
        drop constraint wager_transactions_reference_schedule_consistent,
        drop constraint wager_transactions_trace_identifiers_nonempty,
        drop column reference_attempts,
        drop column next_reference_attempt_at,
        drop column correlation_id,
        drop column causation_id
    `);
  }
}
