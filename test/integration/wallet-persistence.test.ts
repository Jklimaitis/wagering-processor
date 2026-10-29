import { afterAll, beforeAll, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { WalletMapper } from "../../src/infrastructure/database/wallet-mapper";
import { WalletRecord } from "../../src/infrastructure/database/wallet-record";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wager-transaction";
import type { CreateWagerTransactionProps } from "../../src/domain/wager-transaction";
import {
  IdempotencyConflictError,
  PostgresWagerProcessor,
} from "../../src/infrastructure/database/postgres-wager-processor";
import { WagerTransactionRecord } from "../../src/infrastructure/database/wager-transaction-record";
import { WalletLedgerEntryRecord } from "../../src/infrastructure/database/wallet-ledger-entry-record";

const schema = `wallet_persistence_${crypto.randomUUID().replaceAll("-", "")}`;

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
      await orm.em.fork().execute(`drop schema if exists "${schema}" cascade`);
    }
  } finally {
    await orm.close(true);
  }
}, 30_000);

function walletForTest(balance: string): Wallet {
  return Wallet.rehydrate({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    currency: "BRL",
    balance: Money.from({ amount: balance, currency: "BRL" }),
    version: 8,
    createdAt: new Date("2026-10-28T12:00:00.000Z"),
    updatedAt: new Date("2026-10-29T12:00:00.000Z"),
  });
}

test("grava e recupera dinheiro exato e o estado da carteira", async () => {
  const wallet = walletForTest("999999999999999999.99");
  const record = WalletMapper.toRecord(wallet);

  const writer = orm.em.fork({ schema });
  writer.persist(record);
  await writer.flush();

  const reader = orm.em.fork({ schema });

  const loaded = await reader.findOneOrFail(WalletRecord, { id: wallet.id });

  const restored = WalletMapper.toDomain(loaded);

  expect(loaded).not.toBe(record);
  expect(typeof loaded.balance).toBe("string");
  expect(restored.id).toBe(wallet.id);
  expect(restored.playerId).toBe(wallet.playerId);
  expect(restored.currency).toBe("BRL");
  expect(restored.balance.toString()).toBe("999999999999999999.99");
  expect(restored.version).toBe(8);
  expect(restored.createdAt).toEqual(wallet.createdAt);
  expect(restored.updatedAt).toEqual(wallet.updatedAt);
});

test("desfaz a gravação quando a transação SQL falha", async () => {
  const wallet = walletForTest("100.00");
  const writer = orm.em.fork({ schema });

  await expect(
    writer.transactional(async (em) => {
      em.persist(WalletMapper.toRecord(wallet));
      await em.flush();

      throw new Error("Falha simulada após flush");
    }),
  ).rejects.toThrow("Falha simulada após flush");

  const reader = orm.em.fork({ schema });
  const loaded = await reader.findOne(WalletRecord, { id: wallet.id });

  expect(loaded).toBeNull();
});

async function emptyWalletForWagerTest(): Promise<Wallet> {
  const wallet = Wallet.open({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    initialBalance: Money.zero("BRL"),
  });

  const writer = orm.em.fork({ schema });

  writer.persist(WalletMapper.toRecord(wallet));
  await writer.flush();

  return wallet;
}

function wagerPropsForTest(
  wallet: Wallet,
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps {
  const id = crypto.randomUUID();

  return {
    id,
    providerId: "provider-a",
    externalTransactionId: id,
    idempotencyKey: `provider-a:${id}`,
    payloadHash: `test-hash:${id}`,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: Money.from({
      amount: "25.00",
      currency: wallet.currency,
    }),
    ...overrides,
  };
}

test("persiste aposta, saldo e ledger no mesmo processamento", async () => {
  const wallet = await emptyWalletForWagerTest();

  const processor = new PostgresWagerProcessor(orm.em.fork({ schema }));

  await processor.process(
    wagerPropsForTest(wallet, {
      kind: WagerTransactionKind.Win,
      money: Money.from({
        amount: "100.00",
        currency: "BRL",
      }),
    }),
  );

  const bet = wagerPropsForTest(wallet);
  const entryId = crypto.randomUUID();

  const result = await processor.process(bet, entryId);

  expect(result.status).toBe(WagerTransactionStatus.Processed);
  expect(result.balance).toEqual({
    amount: "75.00",
    currency: "BRL",
  });

  const reader = orm.em.fork({ schema });

  const storedWallet = await reader.findOneOrFail(WalletRecord, {
    id: wallet.id,
  });

  const storedTransaction = await reader.findOneOrFail(WagerTransactionRecord, {
    id: bet.id,
  });

  const storedEntry = await reader.findOneOrFail(WalletLedgerEntryRecord, {
    id: entryId,
  });

  expect(storedWallet.balance).toBe("75.00");
  expect(storedWallet.version).toBe(3);

  expect(storedTransaction.status).toBe(WagerTransactionStatus.Processed);
  expect(storedTransaction.resultBalance).toBe("75.00");
  expect(storedTransaction.resultCurrency).toBe("BRL");

  expect(storedEntry.transactionId).toBe(bet.id);
  expect(storedEntry.walletId).toBe(wallet.id);
  expect(storedEntry.direction).toBe("DEBIT");
  expect(storedEntry.amount).toBe("25.00");
  expect(storedEntry.balanceBefore).toBe("100.00");
  expect(storedEntry.balanceAfter).toBe("75.00");

  expect(
    await reader.count(WalletLedgerEntryRecord, { walletId: wallet.id }),
  ).toBe(2);
});

test("falha no ledger desfaz o saldo e a nova transação", async () => {
  const wallet = await emptyWalletForWagerTest();

  const processor = new PostgresWagerProcessor(orm.em.fork({ schema }));

  const existingEntryId = crypto.randomUUID();

  await processor.process(
    wagerPropsForTest(wallet, {
      kind: WagerTransactionKind.Win,
      money: Money.from({
        amount: "100.00",
        currency: "BRL",
      }),
    }),
    existingEntryId,
  );

  const bet = wagerPropsForTest(wallet);

  // Reutilizar o ID provoca uma violação real da PK do ledger.
  await expect(processor.process(bet, existingEntryId)).rejects.toMatchObject({
    code: "23505",
    constraint: "wallet_ledger_entries_pkey",
  });

  const reader = orm.em.fork({ schema });

  const storedWallet = await reader.findOneOrFail(WalletRecord, {
    id: wallet.id,
  });

  expect(storedWallet.balance).toBe("100.00");
  expect(storedWallet.version).toBe(2);

  expect(
    await reader.findOne(WagerTransactionRecord, { id: bet.id }),
  ).toBeNull();

  expect(
    await reader.count(WalletLedgerEntryRecord, { walletId: wallet.id }),
  ).toBe(1);
});

test("replay devolve o saldo original mesmo após outra movimentação", async () => {
  const wallet = await emptyWalletForWagerTest();

  const processor = new PostgresWagerProcessor(orm.em.fork({ schema }));

  await processor.process(
    wagerPropsForTest(wallet, {
      kind: WagerTransactionKind.Win,
      money: Money.from({
        amount: "100.00",
        currency: "BRL",
      }),
    }),
  );

  const bet = wagerPropsForTest(wallet);
  const first = await processor.process(bet);

  expect(first.idempotentReplay).toBe(false);
  expect(first.balance.amount).toBe("75.00");

  await processor.process(
    wagerPropsForTest(wallet, {
      kind: WagerTransactionKind.Win,
      money: Money.from({
        amount: "10.00",
        currency: "BRL",
      }),
    }),
  );

  // Uma nova instância precisa encontrar o resultado no banco.
  const anotherProcessor = new PostgresWagerProcessor(orm.em.fork({ schema }));

  const replay = await anotherProcessor.process({
    ...bet,
    id: crypto.randomUUID(),
  });

  expect(replay).toEqual({
    ...first,
    idempotentReplay: true,
  });

  const reader = orm.em.fork({ schema });

  const storedWallet = await reader.findOneOrFail(WalletRecord, {
    id: wallet.id,
  });

  expect(storedWallet.balance).toBe("85.00");
  expect(storedWallet.version).toBe(4);

  expect(
    await reader.count(WalletLedgerEntryRecord, { walletId: wallet.id }),
  ).toBe(3);
});

test("mesma chave com valor diferente gera conflito sem novo débito", async () => {
  const wallet = await emptyWalletForWagerTest();

  const processor = new PostgresWagerProcessor(orm.em.fork({ schema }));

  await processor.process(
    wagerPropsForTest(wallet, {
      kind: WagerTransactionKind.Win,
      money: Money.from({
        amount: "100.00",
        currency: "BRL",
      }),
    }),
  );

  const bet = wagerPropsForTest(wallet);

  await processor.process(bet);

  await expect(
    processor.process({
      ...bet,
      id: crypto.randomUUID(),
      money: Money.from({
        amount: "26.00",
        currency: "BRL",
      }),
    }),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);

  const reader = orm.em.fork({ schema });

  const storedWallet = await reader.findOneOrFail(WalletRecord, {
    id: wallet.id,
  });

  expect(storedWallet.balance).toBe("75.00");
  expect(storedWallet.version).toBe(3);

  expect(
    await reader.count(WagerTransactionRecord, {
      providerId: bet.providerId,
      externalTransactionId: bet.externalTransactionId,
    }),
  ).toBe(1);

  expect(
    await reader.count(WalletLedgerEntryRecord, { walletId: wallet.id }),
  ).toBe(2);
});
