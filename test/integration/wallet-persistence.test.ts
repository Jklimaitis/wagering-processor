import { afterAll, beforeAll, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import config from '../../src/infrastructure/database/mikro-orm.config';
import { WalletMapper } from '../../src/infrastructure/database/wallet-mapper';
import { WalletRecord } from '../../src/infrastructure/database/wallet-record';

const schema =
  `wallet_persistence_${crypto.randomUUID().replaceAll('-', '')}`;

let orm: MikroORM;
let schemaCreated = false;

beforeAll(async () => {
  orm = await MikroORM.init({
    ...config,
    migrations: {
      ...config.migrations,
      snapshot: false,
    },
  });

  await orm.connect();

  await orm.em.fork().execute(`create schema "${schema}"`);
  schemaCreated = true;

  await orm.migrator.up({ schema });
}, 30_000);

afterAll(async () => {
  if (!orm) {
    return;
  }

  try {
    if (schemaCreated) {
      await orm.em.fork().execute(
        `drop schema if exists "${schema}" cascade`,
      );
    }
  } finally {
    await orm.close(true);
  }
}, 30_000);

function walletForTest(balance: string): Wallet {
  return Wallet.rehydrate({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    currency: 'BRL',
    balance: Money.from({ amount: balance, currency: 'BRL' }),
    version: 8,
    createdAt: new Date('2026-10-28T12:00:00.000Z'),
    updatedAt: new Date('2026-10-29T12:00:00.000Z'),
  });
}

test('grava e recupera dinheiro exato e o estado da carteira', async () => {
  const wallet = walletForTest('999999999999999999.99');
  const record = WalletMapper.toRecord(wallet);

  const writer = orm.em.fork({ schema });
  writer.persist(record);
  await writer.flush(); 

  const reader = orm.em.fork({ schema });

  const loaded = await reader.findOneOrFail(
    WalletRecord,
    { id: wallet.id },
  );

  const restored = WalletMapper.toDomain(loaded);

  expect(loaded).not.toBe(record);
  expect(typeof loaded.balance).toBe('string');
  expect(restored.id).toBe(wallet.id);
  expect(restored.playerId).toBe(wallet.playerId);
  expect(restored.currency).toBe('BRL');
  expect(restored.balance.toString())
    .toBe('999999999999999999.99');
  expect(restored.version).toBe(8);
  expect(restored.createdAt).toEqual(wallet.createdAt);
  expect(restored.updatedAt).toEqual(wallet.updatedAt);
});

test('desfaz a gravação quando a transação SQL falha', async () => {
  const wallet = walletForTest('100.00');
  const writer = orm.em.fork({ schema });

  await expect(
    writer.transactional(async (em) => {
      em.persist(WalletMapper.toRecord(wallet));
      await em.flush();

      throw new Error('Falha simulada após flush');
    }),
  ).rejects.toThrow('Falha simulada após flush');

  const reader = orm.em.fork({ schema });
  const loaded = await reader.findOne(
    WalletRecord,
    { id: wallet.id },
  );

  expect(loaded).toBeNull();
});