import { afterAll, beforeAll, expect, test } from "bun:test"; //beforeAll - prepara o ambiente 1x - afterAll remove somente esse schema temporario
import { MikroORM } from "@mikro-orm/postgresql";
import type { EntityManager } from "@mikro-orm/postgresql";
import config from "../../src/infrastructure/database/mikro-orm.config";

const schema = `wallet_test_${crypto.randomUUID().replaceAll("-", "")}`;
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
      await orm.em.fork().execute(`drop schema if exists "${schema}" cascade`);
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
    currency: "BRL",
    balance: "100.00",
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
    [row.id, row.playerId, row.currency, row.balance, row.version],
  );

  return row.id;
}

test("preserva os centavos no limite monetário", async () => {
  const balance = "999999999999999999.99";
  const id = await insertWallet({ balance });

  const rows = await em.execute<{ balance: string }[]>(
    `select balance from ${table} where id = ?`,
    [id],
  );

  expect(rows[0]?.balance).toBe(balance);
});

test("impede duas carteiras do mesmo jogador e moeda", async () => {
  const playerId = crypto.randomUUID();

  await insertWallet({ playerId });

  await expect(insertWallet({ playerId })).rejects.toMatchObject({
    code: "23505",
    constraint: "wallets_player_currency_unique", // Confirma qual regra do banco foi violada.
  });
});

test("permite moedas diferentes para o mesmo jogador", async () => {
  const playerId = crypto.randomUUID();

  await insertWallet({ playerId, currency: "BRL" });
  await insertWallet({ playerId, currency: "USD" });

  const rows = await em.execute<{ currency: string }[]>(
    `
      select currency
      from ${table}
      where player_id = ?
      order by currency
    `,
    [playerId],
  );

  expect(rows.map((row) => row.currency)).toEqual(["BRL", "USD"]);
});

test("impede saldo negativo no banco", async () => {
  await expect(insertWallet({ balance: "-0.01" })).rejects.toMatchObject({
    code: "23514",
    constraint: "wallets_balance_range",
  });
});

test("impede valor acima da precisão da coluna", async () => {
  await expect(
    insertWallet({
      balance: "1000000000000000000.00",
    }),
  ).rejects.toMatchObject({ code: "22003" }); // erro de limite do numeric
});

test("impede NaN como saldo", async () => {
  await expect(insertWallet({ balance: "NaN" })).rejects.toMatchObject({
    code: "23514",
    constraint: "wallets_balance_range",
  });
});

test("impede moeda não suportada", async () => {
  await expect(insertWallet({ currency: "XYZ" })).rejects.toMatchObject({
    code: "23514",
    constraint: "wallets_currency_supported",
  });
});

test("impede versão inferior a um", async () => {
  await expect(insertWallet({ version: 0 })).rejects.toMatchObject({
    code: "23514",
    constraint: "wallets_version_positive",
  });
});

test("impede saldo nulo", async () => {
  await expect(insertWallet({ balance: null })).rejects.toMatchObject({
    code: "23502",
    table: "wallets",
    column: "balance", // Pra saldo nulo geralmente o Postgre informa a coluna, deixei aqui um exemplo
  });
});

test("não reaplica migrations já registradas", async () => {
  const before = await orm.migrator.getExecuted({ schema });

  await orm.migrator.up({ schema });

  const after = await orm.migrator.getExecuted({ schema });

  expect(before.length).toBeGreaterThan(0);
  expect(after.length).toBe(before.length);
});

test("desfaz e reaplica as migrations no schema de testes", async () => {
  await orm.migrator.down({ schema, to: 0 });

  const removed = await em.execute<{ name: string | null }[]>(
    "select to_regclass(?)::text as name",
    [`${schema}.wallets`],
  );

  expect(removed[0]?.name).toBeNull();

  await orm.migrator.up({ schema });

  const restored = await em.execute<{ name: string | null }[]>(
    "select to_regclass(?)::text as name",
    [`${schema}.wallets`],
  );

  expect(restored[0]?.name).toBeTruthy();
}, 30_000);

interface TestWager {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  kind: string; // WagerTransactionKind - não usei o enum do domínio aqui para não depender de código de produção no teste
  amount: string;
  currency: string;
  status: string; // WagerTransactionStatus - não usei o enum do domínio aqui para não depender de código de produção no teste
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  failureCode: string | null;
  processedAt: Date | null;
  resultBalance: string | null;
  resultCurrency: string | null;
}

const wagerTable = `"${schema}"."wager_transactions"`;

async function insertWager(
  overrides: Partial<TestWager> = {},
): Promise<TestWager> {
  const id = crypto.randomUUID();
  const playerId = overrides.playerId ?? crypto.randomUUID();

  const walletId = overrides.walletId ?? (await insertWallet({ playerId }));

  const row: TestWager = {
    id,
    providerId: "provider-a",
    externalTransactionId: id,
    idempotencyKey: `provider-a:${id}`,
    walletId,
    playerId,
    kind: "BET",
    amount: "25.00",
    currency: "BRL",
    status: "PENDING",
    referenceExternalTransactionId: null,
    referenceTransactionId: null,
    failureCode: null,
    processedAt: null,
    resultBalance: null,
    resultCurrency: null,
    ...overrides,
  };

  await em.execute(
    `
      insert into ${wagerTable} (
        id, provider_id, external_transaction_id,
        idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id,
        kind, amount, currency,
        reference_external_transaction_id,
        reference_transaction_id,
        status, failure_code, processed_at,
        result_balance, result_currency, created_at
      )
      values (
        ?, ?, ?, ?, 'test-hash',
        ?, ?, 'round-1', 'game-1',
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now()
      )
    `,
    [
      row.id,
      row.providerId,
      row.externalTransactionId,
      row.idempotencyKey,
      row.walletId,
      row.playerId,
      row.kind,
      row.amount,
      row.currency,
      row.referenceExternalTransactionId,
      row.referenceTransactionId,
      row.status,
      row.failureCode,
      row.processedAt,
      row.resultBalance,
      row.resultCurrency,
    ],
  );

  return row;
}

test("preserva o valor da aposta e o saldo observado", async () => {
  const row = await insertWager({
    amount: "999999999999999999.99",
    resultBalance: "75.00",
    resultCurrency: "USD",
  });

  const rows = await em.execute<
    {
      amount: string;
      result_balance: string;
      result_currency: string;
    }[]
  >(
    `
      select amount, result_balance, result_currency
      from ${wagerTable}
      where id = ?
    `,
    [row.id],
  );

  expect(rows[0]).toEqual({
    amount: "999999999999999999.99",
    result_balance: "75.00",
    result_currency: "USD",
  });
});

test("impede repetir a idempotency key no banco", async () => {
  const original = await insertWager();

  await expect(
    insertWager({
      idempotencyKey: original.idempotencyKey,
    }),
  ).rejects.toMatchObject({
    code: "23505",
    constraint: "wager_transactions_idempotency_key_unique",
  });
});

test("impede repetir a operação do provedor com outra key", async () => {
  const original = await insertWager();

  await expect(
    insertWager({
      providerId: original.providerId,
      externalTransactionId: original.externalTransactionId,
    }),
  ).rejects.toMatchObject({
    code: "23505",
    constraint: "wager_transactions_provider_external_unique",
  });
});

test.each(["-0.01", "0.00", "NaN"])(
  "impede BET com valor inválido %s no banco",
  async (amount) => {
    await expect(insertWager({ amount })).rejects.toMatchObject({
      code: "23514",
      constraint: "wager_transactions_amount_valid",
    });
  },
);

test("permite LOSS com valor zero", async () => {
  const row = await insertWager({
    kind: "LOSS",
    amount: "0.00",
  });

  const rows = await em.execute<{ amount: string }[]>(
    `select amount from ${wagerTable} where id = ?`,
    [row.id],
  );

  expect(rows[0]?.amount).toBe("0.00");
});

test.each(["REFUND", "ROLLBACK"])(
  "impede dois %s processados e preserva a tentativa rejeitada",
  async (kind) => {
    const at = new Date("2026-10-29T12:00:00.000Z");

    const original = await insertWager({
      status: "PROCESSED",
      processedAt: at,
    });

    const reversal: Partial<TestWager> = {
      walletId: original.walletId,
      playerId: original.playerId,
      kind,
      status: "PROCESSED",
      processedAt: at,
      referenceExternalTransactionId: original.externalTransactionId,
      referenceTransactionId: original.id,
    };

    await insertWager(reversal);

    await expect(insertWager(reversal)).rejects.toMatchObject({
      code: "23505",
      constraint: "wager_transactions_processed_reversal_unique",
    });

    await insertWager({
      ...reversal,
      status: "REJECTED",
      processedAt: null,
      failureCode: "ALREADY_REVERSED",
    });

    const rows = await em.execute<{ status: string }[]>(
      `
        select status
        from ${wagerTable}
        where reference_transaction_id = ?
          and kind = ?
        order by status
      `,
      [original.id, kind],
    );

    expect(rows.map((row) => row.status)).toEqual(["PROCESSED", "REJECTED"]);
  },
);

test("reverte a nova migration preservando wallets", async () => {
  const walletId = await insertWallet();

  await orm.migrator.down({
    schema,
    to: "Migration20261029000100",
  });

  const removed = await em.execute<{ name: string | null }[]>(
    "select to_regclass(?)::text as name",
    [`${schema}.wager_transactions`],
  );

  expect(removed[0]?.name).toBeNull();

  const wallets = await em.execute<{ id: string }[]>(
    `select id from ${table} where id = ?`,
    [walletId],
  );

  expect(wallets[0]?.id).toBe(walletId);

  await orm.migrator.up({ schema });

  const restored = await em.execute<{ name: string | null }[]>(
    "select to_regclass(?)::text as name",
    [`${schema}.wager_transactions`],
  );

  expect(restored[0]?.name).not.toBeNull();
}, 30_000);

const ledgerTable = `"${schema}"."wallet_ledger_entries"`;

interface TestLedger {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
}

function processedWagerForLedger(
  overrides: Partial<TestWager> = {},
): Promise<TestWager> {
  return insertWager({
    status: "PROCESSED",
    processedAt: new Date(),
    ...overrides,
  });
}

async function insertLedger(
  wager: TestWager,
  overrides: Partial<TestLedger> = {},
): Promise<TestLedger> {
  const row: TestLedger = {
    id: crypto.randomUUID(),
    walletId: wager.walletId,
    transactionId: wager.id,
    direction: "DEBIT",
    amount: wager.amount,
    currency: wager.currency,
    balanceBefore: "100.00",
    balanceAfter: "75.00",
    ...overrides,
  };

  await em.execute(
    `
      insert into ${ledgerTable} (
        id, wallet_id, transaction_id,
        direction, amount, currency,
        balance_before, balance_after, created_at
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, now())
    `,
    [
      row.id,
      row.walletId,
      row.transactionId,
      row.direction,
      row.amount,
      row.currency,
      row.balanceBefore,
      row.balanceAfter,
    ],
  );

  return row;
}

test.each(["UPDATE", "DELETE", "TRUNCATE"] as const)(
  "bloqueia %s diretamente no PostgreSQL",
  async (operation) => {
    const wager = await processedWagerForLedger();
    const entry = await insertLedger(wager);

    const before = await em.execute(
      `select * from ${ledgerTable} where id = ?`,
      [entry.id],
    );

    const commands = {
      UPDATE: `
        update ${ledgerTable}
        set created_at = created_at + interval '1 second'
        where id = ?
      `,
      DELETE: `delete from ${ledgerTable} where id = ?`,
      TRUNCATE: `truncate table ${ledgerTable}`,
    };

    const params = operation === "TRUNCATE" ? [] : [entry.id];

    await expect(em.execute(commands[operation], params)).rejects.toMatchObject(
      {
        code: "23514",
        constraint: "wallet_ledger_entries_immutable",
      },
    );

    const after = await em.execute(
      `select * from ${ledgerTable} where id = ?`,
      [entry.id],
    );

    expect(after).toEqual(before);
  },
);

test("impede dois lançamentos da mesma transação e wallet", async () => {
  const wager = await processedWagerForLedger();

  await insertLedger(wager);

  await expect(insertLedger(wager)).rejects.toMatchObject({
    code: "23505",
    constraint: "wallet_ledger_entries_wallet_transaction_unique",
  });
});

test("impede lançamento cuja aritmética não fecha", async () => {
  const wager = await processedWagerForLedger();

  await expect(
    insertLedger(wager, {
      balanceAfter: "74.00",
    }),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "wallet_ledger_entries_balanced",
  });
});

test.each(["wallet", "currency"] as const)(
  "impede ledger com %s diferente da transação",
  async (field) => {
    const wager = await processedWagerForLedger();

    const changes: Partial<TestLedger> =
      field === "wallet"
        ? { walletId: await insertWallet() }
        : { currency: "USD" };

    await expect(insertLedger(wager, changes)).rejects.toMatchObject({
      code: "23503",
      constraint: "wallet_ledger_entries_transaction_context_fk",
    });
  },
);

test.each([
  {
    direction: "DEBIT",
    kind: "BET",
    amount: "0.01",
    before: "999999999999999999.99",
    after: "999999999999999999.98",
  },
  {
    direction: "CREDIT",
    kind: "WIN",
    amount: "999999999999999999.99",
    before: "0.00",
    after: "999999999999999999.99",
  },
])("preserva valores exatos no ledger %j", async (scenario) => {
  const wager = await processedWagerForLedger({
    kind: scenario.kind,
    amount: scenario.amount,
  });

  const entry = await insertLedger(wager, {
    direction: scenario.direction,
    balanceBefore: scenario.before,
    balanceAfter: scenario.after,
  });

  const rows = await em.execute<
    {
      amount: string;
      balance_before: string;
      balance_after: string;
    }[]
  >(
    `
      select amount, balance_before, balance_after
      from ${ledgerTable}
      where id = ?
    `,
    [entry.id],
  );

  expect(rows[0]).toEqual({
    amount: scenario.amount,
    balance_before: scenario.before,
    balance_after: scenario.after,
  });
});

test.each([
  {
    amount: "0.00",
    balanceBefore: "100.00",
    balanceAfter: "100.00",
    constraint: "wallet_ledger_entries_amount_valid",
  },
  {
    amount: "-1.00",
    balanceBefore: "100.00",
    balanceAfter: "101.00",
    constraint: "wallet_ledger_entries_amount_valid",
  },
  {
    amount: "25.00",
    balanceBefore: "10.00",
    balanceAfter: "-15.00",
    constraint: "wallet_ledger_entries_balances_valid",
  },
])("rejeita valores inválidos no ledger %j", async (scenario) => {
  const wager = await processedWagerForLedger();

  await expect(
    insertLedger(wager, {
      amount: scenario.amount,
      balanceBefore: scenario.balanceBefore,
      balanceAfter: scenario.balanceAfter,
    }),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: scenario.constraint,
  });
});

test("reverte o ledger preservando as transações existentes", async () => {
  const wager = await processedWagerForLedger();

  await orm.migrator.down({
    schema,
    to: "Migration20261029000200",
  });

  const removed = await em.execute<{ name: string | null }[]>(
    "select to_regclass(?)::text as name",
    [`${schema}.wallet_ledger_entries`],
  );

  expect(removed[0]?.name).toBeNull();

  const preserved = await em.execute<{ id: string }[]>(
    `select id from ${wagerTable} where id = ?`,
    [wager.id],
  );

  expect(preserved[0]?.id).toBe(wager.id);

  const functions = await em.execute<{ name: string | null }[]>(
    "select to_regprocedure(?)::text as name",
    [`${schema}.reject_wallet_ledger_mutation()`],
  );

  expect(functions[0]?.name).toBeNull();

  await orm.migrator.up({ schema });

  await expect(
    em.execute(`truncate table ${ledgerTable}`),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "wallet_ledger_entries_immutable",
  });
}, 30_000);
