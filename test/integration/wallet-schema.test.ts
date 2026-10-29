import { afterAll, beforeAll, expect, test } from 'bun:test'; //beforeAll - prepara o ambiente 1x - afterAll remove somente esse schema temporario
import { MikroORM } from '@mikro-orm/postgresql';
import type { EntityManager } from '@mikro-orm/postgresql';
import config from '../../src/infrastructure/database/mikro-orm.config';

const schema = `wallet_test_${crypto.randomUUID().replaceAll('-', '')}`;
const table = `"${schema}"."wallets"`;

let orm: MikroORM;
let em: EntityManager;
let schemaCreated = false;

// verificar codigos do Postgree 

beforeAll(async () => {
  orm = await MikroORM.init({
    ...config,
    migrations: {
      ...config.migrations,
      snapshot: false,
    },
  });

  await orm.connect();
  em = orm.em.fork();

  await em.execute(`create schema "${schema}"`);
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

interface TestWallet {
  id: string;
  playerId: string;
  currency: string;
  balance: string | null;
  version: number;
}

async function insertWallet(
  overrides: Partial<TestWallet> = {},
): Promise<string> {
  const row: TestWallet = {
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    currency: 'BRL',
    balance: '100.00',
    version: 1,
    ...overrides,
  };

  await em.execute(
    `
      insert into ${table} (
        id,
        player_id,
        currency,
        balance,
        version,
        created_at,
        updated_at
      )
      values (?, ?, ?, ?, ?, now(), now())
    `,
    [
      row.id,
      row.playerId,
      row.currency,
      row.balance,
      row.version,
    ],
  );

  return row.id;
}

test('preserva os centavos no limite monetário', async () => {
  const balance = '999999999999999999.99';
  const id = await insertWallet({ balance });

  const rows = await em.execute<{ balance: string }[]>(
    `select balance from ${table} where id = ?`,
    [id],
  );

  expect(rows[0]?.balance).toBe(balance);
});

test('impede duas carteiras do mesmo jogador e moeda', async () => {
  const playerId = crypto.randomUUID();

  await insertWallet({ playerId });

  await expect(insertWallet({ playerId }))
    .rejects.toMatchObject({
      code: '23505',
      constraint: 'wallets_player_currency_unique', // Confirma qual regra do banco foi violada.
    });
});

test('permite moedas diferentes para o mesmo jogador', async () => {
  const playerId = crypto.randomUUID();

  await insertWallet({ playerId, currency: 'BRL' });
  await insertWallet({ playerId, currency: 'USD' });

  const rows = await em.execute<{ currency: string }[]>(
    `
      select currency
      from ${table}
      where player_id = ?
      order by currency
    `,
    [playerId],
  );

  expect(rows.map((row) => row.currency)).toEqual(['BRL', 'USD']);
});

test('impede saldo negativo no banco', async () => {
  await expect(insertWallet({ balance: '-0.01' }))
    .rejects.toMatchObject({
      code: '23514',
      constraint: 'wallets_balance_range',
    });
});

test('impede valor acima da precisão da coluna', async () => {
  await expect(insertWallet({
    balance: '1000000000000000000.00',
  })).rejects.toMatchObject({ code: '22003' }); // erro de limite do numeric
});

test('impede NaN como saldo', async () => {
  await expect(insertWallet({ balance: 'NaN' }))
    .rejects.toMatchObject({
      code: '23514',
      constraint: 'wallets_balance_range',
    });
});

test('impede moeda não suportada', async () => {
  await expect(insertWallet({ currency: 'XYZ' }))
    .rejects.toMatchObject({
      code: '23514',
      constraint: 'wallets_currency_supported',
    });
});

test('impede versão inferior a um', async () => {
  await expect(insertWallet({ version: 0 }))
    .rejects.toMatchObject({
      code: '23514',
      constraint: 'wallets_version_positive',
    });
});

test('impede saldo nulo', async () => {
  await expect(insertWallet({ balance: null }))
    .rejects.toMatchObject({
      code: '23502',
      table: 'wallets',
      column: 'balance', // Pra saldo nulo geralmente o Postgre informa a coluna, deixei aqui um exemplo
    });
});

test('não reaplica migrations já registradas', async () => {
  const before = await orm.migrator.getExecuted({ schema });

  await orm.migrator.up({ schema });

  const after = await orm.migrator.getExecuted({ schema });

  expect(before.length).toBeGreaterThan(0);
  expect(after.length).toBe(before.length);
});

test('desfaz e reaplica as migrations no schema de testes', async () => {
  await orm.migrator.down({ schema, to: 0 });

  const removed = await em.execute<{ name: string | null }[]>(
    'select to_regclass(?)::text as name',
    [`${schema}.wallets`],
  );

  expect(removed[0]?.name).toBeNull();

  await orm.migrator.up({ schema });

  const restored = await em.execute<{ name: string | null }[]>(
    'select to_regclass(?)::text as name',
    [`${schema}.wallets`],
  );

  expect(restored[0]?.name).toBeTruthy();
}, 30_000);