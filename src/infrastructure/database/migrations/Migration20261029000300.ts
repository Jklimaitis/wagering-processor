import { Migration } from "@mikro-orm/migrations";

export class Migration20261029000300 extends Migration {
  override up(): void {
    this.addSql(`
      alter table wager_transactions
      add constraint wager_transactions_id_wallet_currency_unique
      unique (id, wallet_id, currency);
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null,
        transaction_id uuid not null,
        direction text not null,
        amount numeric(20, 2) not null,
        currency varchar(3) not null,
        balance_before numeric(20, 2) not null,
        balance_after numeric(20, 2) not null,
        created_at timestamptz not null,

        constraint wallet_ledger_entries_transaction_context_fk
          foreign key (transaction_id, wallet_id, currency)
          references wager_transactions (id, wallet_id, currency)
          on delete restrict,

        constraint wallet_ledger_entries_wallet_transaction_unique
          unique (wallet_id, transaction_id),

        constraint wallet_ledger_entries_direction_check
          check (direction in ('DEBIT', 'CREDIT')),

        constraint wallet_ledger_entries_currency_supported
          check (currency in ('BRL', 'USD')),

        constraint wallet_ledger_entries_amount_valid
          check (
            amount > 0
            and amount <= 999999999999999999.99
          ),

        constraint wallet_ledger_entries_balances_valid
          check (
            balance_before >= 0
            and balance_before <= 999999999999999999.99
            and balance_after >= 0
            and balance_after <= 999999999999999999.99
          ),

        constraint wallet_ledger_entries_balanced
          check (
            (
              direction = 'DEBIT'
              and balance_after = balance_before - amount
            )
            or (
              direction = 'CREDIT'
              and balance_after = balance_before + amount
            )
          )
      );
    `);

    this.addSql(`
      create index wallet_ledger_entries_wallet_created_idx
      on wallet_ledger_entries (wallet_id, created_at, id);
    `);

    this.addSql(`
      create function reject_wallet_ledger_mutation()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception using
          errcode = '23514',
          message = 'Lançamentos do ledger são imutáveis.',
          constraint = 'wallet_ledger_entries_immutable';
      end;
      $$;
    `);

    this.addSql(`
      create trigger wallet_ledger_entries_immutable
      before update or delete or truncate
      on wallet_ledger_entries
      for each statement
      execute function reject_wallet_ledger_mutation();
    `);
  }

  override down(): void {
    this.addSql("drop table wallet_ledger_entries;");

    this.addSql("drop function reject_wallet_ledger_mutation();");

    this.addSql(`
      alter table wager_transactions
      drop constraint wager_transactions_id_wallet_currency_unique;
    `);
  }
}
