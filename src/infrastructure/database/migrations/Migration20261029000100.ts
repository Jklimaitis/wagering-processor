import { Migration } from '@mikro-orm/migrations';

/*
Cada carteira deve ter um identificador unico (UUID)
'not null' para cada campo pois precisa ter um valor

'wallets_player_currency_unique' - Uma carteira por jogador e moeda
'wallets_currency_supported' - Moedas aceitas na carteira, o jogador pode ter 2 carteiras (1 BRL e 1 USD) mas nunca 2 (BRL ou 2 USD)
'wallets_balance_range' limite de saldo na carteira
'wallets_version_positive' versão da carteira sempre positiva, igual ou superior a 1

up() - aplica a alteração
down() desfaz a estrutura, aqui no caso executar down excluiria os dados da  minha tabela
*/

export class Migration20261029000100 extends Migration {
  override up(): void {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency varchar(3) not null,
        balance numeric(20, 2) not null,
        version integer not null default 1,
        created_at timestamptz not null,
        updated_at timestamptz not null,

        constraint wallets_player_currency_unique
          unique (player_id, currency),

        constraint wallets_currency_supported
          check (currency in ('BRL', 'USD')),

        constraint wallets_balance_range
          check (
            balance >= 0
            and balance <= 999999999999999999.99
          ),

        constraint wallets_version_positive
          check (version >= 1)
      );
    `);
  }

  override down(): void {
    this.addSql('drop table wallets;');
  }
}