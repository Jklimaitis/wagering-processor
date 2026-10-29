import { Migration } from "@mikro-orm/migrations";

export class Migration20261029000200 extends Migration {
  override up(): void {
    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null,
        player_id uuid not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        amount numeric(20, 2) not null,
        currency varchar(3) not null,
        result_balance numeric(20, 2),
        result_currency varchar(3),
        reference_external_transaction_id text,
        reference_transaction_id uuid,
        status text not null,
        failure_code text,
        created_at timestamptz not null,
        processed_at timestamptz,

        constraint wager_transactions_wallet_fk
          foreign key (wallet_id)
          references wallets (id)
          on delete restrict,

        constraint wager_transactions_reference_fk
          foreign key (reference_transaction_id)
          references wager_transactions (id)
          on delete restrict,

        constraint wager_transactions_idempotency_key_unique
          unique (idempotency_key),

        constraint wager_transactions_provider_external_unique
          unique (provider_id, external_transaction_id),

        constraint wager_transactions_kind_check
          check (
            kind in (
              'OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'
            )
          ),

        constraint wager_transactions_status_check
          check (
            status in (
              'PENDING', 'PENDING_REFERENCE',
              'PROCESSED', 'REJECTED', 'FAILED'
            )
          ),

        constraint wager_transactions_failure_code_check
          check (
            failure_code in (
              'INSUFFICIENT_BALANCE',
              'INSUFFICIENT_BALANCE_FOR_REVERSAL',
              'REFERENCE_NOT_FOUND',
              'INVALID_REFERENCE',
              'ALREADY_REVERSED',
              'PERMANENT_INFRASTRUCTURE_ERROR',
              'WALLET_MISMATCH',
              'PLAYER_MISMATCH',
              'CURRENCY_MISMATCH',
              'MONETARY_LIMIT_EXCEEDED'
            )
          ),

        constraint wager_transactions_currency_supported
          check (currency in ('BRL', 'USD')),

        constraint wager_transactions_amount_valid
          check (
            amount >= 0
            and amount <= 999999999999999999.99
            and (kind = 'LOSS' or amount > 0)
          ),

        constraint wager_transactions_reference_required
          check (
            kind not in ('REFUND', 'ROLLBACK')
            or (
              reference_external_transaction_id is not null
              and length(trim(reference_external_transaction_id)) > 0
            )
          ),

        constraint wager_transactions_processed_at_consistent
          check (
            (status = 'PROCESSED') = (processed_at is not null)
          ),

        constraint wager_transactions_failure_code_consistent
          check (
            (status in ('REJECTED', 'FAILED'))
            = (failure_code is not null)
          ),

        constraint wager_transactions_processed_reference_consistent
          check (
            status <> 'PROCESSED'
            or (
              (reference_external_transaction_id is null)
              = (reference_transaction_id is null)
            )
          ),

        constraint wager_transactions_result_balance_valid
          check (
            (
              result_balance is null
              and result_currency is null
            )
            or (
              result_balance is not null
              and result_currency is not null
              and result_balance >= 0
              and result_balance <= 999999999999999999.99
              and result_currency in ('BRL', 'USD')
            )
          )
      );
    `);

    this.addSql(`
      create unique index
        wager_transactions_processed_reversal_unique
      on wager_transactions (reference_transaction_id, kind)
      where status = 'PROCESSED'
        and kind in ('REFUND', 'ROLLBACK');
    `);

    this.addSql(`
      create index wager_transactions_wallet_created_idx
      on wager_transactions (wallet_id, created_at, id);
    `);
  }

  override down(): void {
    this.addSql("drop table wager_transactions;");
  }
}
