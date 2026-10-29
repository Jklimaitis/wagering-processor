import { afterAll, beforeAll, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { WalletMapper } from "../../src/infrastructure/database/wallet-mapper";
import { WalletRecord } from "../../src/infrastructure/database/wallet-record";
import {
  FailureCode,
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
import { LedgerDirection } from "../../src/domain/wallet-ledger-entry";
import { fileURLToPath } from "node:url";
import type { WagerWorkerOutput } from "../helpers/wager-worker";

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
  expect(storedEntry.direction).toBe(LedgerDirection.Debit);
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

async function expectLedgerMatchesWallet(walletId: string): Promise<void> {
  const reader = orm.em.fork({ schema });

  const wallet = await reader.findOneOrFail(WalletRecord, { id: walletId });

  const rows = await reader.execute<{ balance: string }[]>(
    `
      select coalesce(
        sum(
          case
            when direction = 'CREDIT' then amount
            else -amount
          end
        ),
        0
      )::numeric(20, 2)::text as balance
      from "${schema}".wallet_ledger_entries
      where wallet_id = ?
    `,
    [walletId],
  );

  expect(rows[0]?.balance).toBe(wallet.balance);
}

test("50 envios paralelos da mesma aposta produzem um único débito", async () => {
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

  const attempts = await Promise.allSettled(
    Array.from({ length: 50 }, () => {
      const instance = new PostgresWagerProcessor(orm.em.fork({ schema }));

      return instance.process({
        ...bet,
        id: crypto.randomUUID(),
      });
    }),
  );

  expect(attempts.filter((attempt) => attempt.status === "rejected")).toEqual(
    [],
  );

  const results = attempts.flatMap((attempt) =>
    attempt.status === "fulfilled" ? [attempt.value] : [],
  );

  expect(results).toHaveLength(50);

  expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);

  expect(results.filter((result) => result.idempotentReplay)).toHaveLength(49);

  expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);

  expect(
    results.every(
      (result) =>
        result.status === WagerTransactionStatus.Processed &&
        result.balance.amount === "75.00" &&
        result.balance.currency === "BRL",
    ),
  ).toBe(true);

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
    await reader.count(WalletLedgerEntryRecord, {
      walletId: wallet.id,
      direction: LedgerDirection.Debit,
    }),
  ).toBe(1);

  await expectLedgerMatchesWallet(wallet.id);
}, 30_000);

test("duas apostas paralelas de 80 disputam saldo de 100", async () => {
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

  const bets = Array.from({ length: 2 }, () =>
    wagerPropsForTest(wallet, {
      money: Money.from({
        amount: "80.00",
        currency: "BRL",
      }),
    }),
  );

  const attempts = await Promise.allSettled(
    bets.map((bet) => {
      const instance = new PostgresWagerProcessor(orm.em.fork({ schema }));

      return instance.process(bet);
    }),
  );

  expect(attempts.filter((attempt) => attempt.status === "rejected")).toEqual(
    [],
  );

  const results = attempts.flatMap((attempt) =>
    attempt.status === "fulfilled" ? [attempt.value] : [],
  );

  expect(results).toHaveLength(2);

  expect(
    results.filter(
      (result) => result.status === WagerTransactionStatus.Processed,
    ),
  ).toHaveLength(1);

  const rejected = results.filter(
    (result) => result.status === WagerTransactionStatus.Rejected,
  );

  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.failureCode).toBe(FailureCode.InsufficientBalance);

  expect(results.every((result) => result.balance.amount === "20.00")).toBe(
    true,
  );

  // Reenvia tanto a aposta processada quanto a rejeitada.
  for (const bet of bets) {
    const replay = await processor.process({
      ...bet,
      id: crypto.randomUUID(),
    });

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance.amount).toBe("20.00");
  }

  const reader = orm.em.fork({ schema });

  const storedWallet = await reader.findOneOrFail(WalletRecord, {
    id: wallet.id,
  });

  expect(storedWallet.balance).toBe("20.00");
  expect(storedWallet.version).toBe(3);

  expect(
    await reader.count(WalletLedgerEntryRecord, {
      walletId: wallet.id,
      direction: LedgerDirection.Debit,
    }),
  ).toBe(1);

  await expectLedgerMatchesWallet(wallet.id);
}, 30_000);

function startWagerWorker() {
  const workerPath = fileURLToPath(
    new URL("../helpers/wager-worker.ts", import.meta.url),
  );

  let worker!: Bun.Subprocess<"ignore", "pipe", "pipe">;

  const ready = new Promise<void>((resolve, reject) => {
    worker = Bun.spawn([process.execPath, workerPath, schema], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,

      ipc(message: unknown) {
        if (message === "ready") {
          resolve();
        }
      },

      onExit(_worker, exitCode) {
        reject(new Error(`Worker encerrou antes da liberação: ${exitCode}`));
      },
    });
  });

  return {
    worker,
    ready,
    stdout: new Response(worker.stdout).text(),
    stderr: new Response(worker.stderr).text(),
  };
}

test("três processos disputam o saldo da mesma wallet", async () => {
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

  const workers = Array.from({ length: 3 }, () => startWagerWorker());

  try {
    // Todos precisam estar conectados antes de liberar as apostas.
    await Promise.all(workers.map((handle) => handle.ready));

    for (const handle of workers) {
      const bet = wagerPropsForTest(wallet, {
        money: Money.from({
          amount: "80.00",
          currency: "BRL",
        }),
      });

      handle.worker.send(
        JSON.stringify({
          ...bet,
          money: bet.money.toJSON(),
        }),
      );
    }

    const outputs = await Promise.all(
      workers.map(async (handle) => {
        const [stdout, stderr, exitCode] = await Promise.all([
          handle.stdout,
          handle.stderr,
          handle.worker.exited,
        ]);

        if (exitCode !== 0) {
          throw new Error(`Worker falhou (${exitCode}): ${stderr}`);
        }

        return JSON.parse(stdout) as WagerWorkerOutput;
      }),
    );

    expect(new Set(outputs.map((output) => output.pid)).size).toBe(3);

    const results = outputs.map((output) => output.result);

    expect(
      results.filter(
        (result) => result.status === WagerTransactionStatus.Processed,
      ),
    ).toHaveLength(1);

    const rejected = results.filter(
      (result) => result.status === WagerTransactionStatus.Rejected,
    );

    expect(rejected).toHaveLength(2);

    expect(
      rejected.every(
        (result) => result.failureCode === FailureCode.InsufficientBalance,
      ),
    ).toBe(true);

    expect(
      results.every(
        (result) =>
          result.balance.amount === "20.00" &&
          result.balance.currency === "BRL",
      ),
    ).toBe(true);

    const reader = orm.em.fork({ schema });

    const storedWallet = await reader.findOneOrFail(WalletRecord, {
      id: wallet.id,
    });

    expect(storedWallet.balance).toBe("20.00");
    expect(storedWallet.version).toBe(3);

    expect(
      await reader.count(WagerTransactionRecord, {
        walletId: wallet.id,
        kind: WagerTransactionKind.Bet,
      }),
    ).toBe(3);

    expect(
      await reader.count(WalletLedgerEntryRecord, {
        walletId: wallet.id,
        direction: LedgerDirection.Debit,
      }),
    ).toBe(1);

    await expectLedgerMatchesWallet(wallet.id);
  } finally {
    for (const handle of workers) {
      if (
        handle.worker.exitCode === null &&
        handle.worker.signalCode === null
      ) {
        handle.worker.kill();
      }
    }

    await Promise.allSettled(workers.map((handle) => handle.worker.exited));
  }
}, 30_000);

test("processa wallets distintas em paralelo preservando seus saldos", async () => {
  const scenarios = await Promise.all(
    [
      { amount: "10.00", expected: "90.00" },
      { amount: "20.00", expected: "80.00" },
      { amount: "30.00", expected: "70.00" },
    ].map(async (scenario) => {
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

      return { ...scenario, wallet, processor };
    }),
  );

  const attempts = await Promise.allSettled(
    scenarios.map(async ({ wallet, processor, amount, expected }) => {
      const result = await processor.process(
        wagerPropsForTest(wallet, {
          money: Money.from({
            amount,
            currency: "BRL",
          }),
        }),
      );

      return { wallet, expected, result };
    }),
  );

  expect(attempts.filter((attempt) => attempt.status === "rejected")).toEqual(
    [],
  );

  for (const attempt of attempts) {
    if (attempt.status !== "fulfilled") {
      continue;
    }

    const { wallet, expected, result } = attempt.value;

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe(expected);
    expect(result.idempotentReplay).toBe(false);

    const reader = orm.em.fork({ schema });

    const storedWallet = await reader.findOneOrFail(WalletRecord, {
      id: wallet.id,
    });

    expect(storedWallet.balance).toBe(expected);
    expect(storedWallet.version).toBe(3);

    expect(
      await reader.count(WalletLedgerEntryRecord, {
        walletId: wallet.id,
        direction: LedgerDirection.Debit,
      }),
    ).toBe(1);

    await expectLedgerMatchesWallet(wallet.id);
  }
}, 30_000);

test("mesma chave concorrente em wallets distintas gera um conflito", async () => {
  const wallets = await Promise.all([
    emptyWalletForWagerTest(),
    emptyWalletForWagerTest(),
  ]);

  const processor = new PostgresWagerProcessor(orm.em.fork({ schema }));

  for (const wallet of wallets) {
    await processor.process(
      wagerPropsForTest(wallet, {
        kind: WagerTransactionKind.Win,
        money: Money.from({
          amount: "100.00",
          currency: "BRL",
        }),
      }),
    );
  }

  const idempotencyKey = `shared:${crypto.randomUUID()}`;

  const attempts = await Promise.allSettled(
    wallets.map((wallet) =>
      processor.process(
        wagerPropsForTest(wallet, {
          idempotencyKey,
        }),
      ),
    ),
  );

  const successful = attempts.flatMap((attempt) =>
    attempt.status === "fulfilled" ? [attempt.value] : [],
  );

  const errors = attempts.flatMap((attempt) =>
    attempt.status === "rejected" ? [attempt.reason] : [],
  );

  expect(successful).toHaveLength(1);
  expect(successful[0]?.status).toBe(WagerTransactionStatus.Processed);
  expect(successful[0]?.idempotentReplay).toBe(false);

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(IdempotencyConflictError);

  const reader = orm.em.fork({ schema });
  const walletIds = wallets.map((wallet) => wallet.id);

  const storedWallets = await reader.find(WalletRecord, {
    id: { $in: walletIds },
  });

  expect(storedWallets.map((wallet) => wallet.balance).sort()).toEqual([
    "100.00",
    "75.00",
  ]);

  expect(storedWallets.map((wallet) => wallet.version).sort()).toEqual([2, 3]);

  expect(await reader.count(WagerTransactionRecord, { idempotencyKey })).toBe(
    1,
  );

  expect(
    await reader.count(WalletLedgerEntryRecord, {
      walletId: { $in: walletIds },
      direction: LedgerDirection.Debit,
    }),
  ).toBe(1);

  for (const wallet of wallets) {
    await expectLedgerMatchesWallet(wallet.id);
  }
}, 30_000);
