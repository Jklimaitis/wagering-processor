import { DecimalType, EntitySchema } from '@mikro-orm/core';

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  schema: '*', // usar public na aplicação e schema temporario nos testes

  properties: {
    id: {
      type: 'uuid',
      primary: true,
    },
    playerId: {
      type: 'uuid',
      fieldName: 'player_id',
    },
    currency: {
      type: 'string',
      length: 3,
    },
    balance: {
      type: new DecimalType('string'), //manter a representação monetaria como string
      precision: 20,
      scale: 2,
    },
    version: {
      type: 'integer',
      default: 1,
    },
    createdAt: {
      type: Date,
      columnType: 'timestamptz',
      fieldName: 'created_at',
    },
    updatedAt: {
      type: Date,
      columnType: 'timestamptz',
      fieldName: 'updated_at',
    },
  },

  uniques: [
    {
      name: 'wallets_player_currency_unique',
      properties: ['playerId', 'currency'],
    },
  ],

  checks: [
    {
      name: 'wallets_currency_supported',
      expression: "currency in ('BRL', 'USD')",
    },
    {
      name: 'wallets_balance_range',
      expression:
        'balance >= 0 and balance <= 999999999999999999.99',
    },
    {
      name: 'wallets_version_positive',
      expression: 'version >= 1',
    },
  ],
});