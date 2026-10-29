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
import { OutboxMessage } from "../../src/domain/outbox-message";
import { WagerTransactionProcessed } from "../../src/domain/wager-transaction-events";
import { WagerTransactionMapper } from "../../src/infrastructure/database/wager-transaction-mapper";
import { OutboxMessageMapper } from "../../src/infrastructure/database/outbox-message-mapper";
import { OutboxMessageRecord } from "../../src/infrastructure/database/outbox-message-record";
import { InboxMessage } from "../../src/domain/inbox-message";
import { InboxMessageMapper } from "../../src/infrastructure/database/inbox-message-mapper";
import { InboxMessageRecord } from "../../src/infrastructure/database/inbox-message-record";
import {
  InboxPayloadConflictError,
  PostgresInboxWagerProcessor,
} from "../../src/infrastructure/database/postgres-inbox-wager-processor";

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

async function outboxForPersistenceTest(): Promise<OutboxMessage> {
  const wallet = await emptyWalletForWagerTest();

  const props = wagerPropsForTest(wallet, {
    kind: WagerTransactionKind.Win,
    money: Money.from({
      amount: "999999999999999999.99",
      currency: "BRL",
    }),
  });

  const processor = new PostgresWagerProcessor(orm.em.fork({ schema }));

  await processor.process(props);

  const record = await orm.em
    .fork({ schema })
    .findOneOrFail(WagerTransactionRecord, { id: props.id });

  const event = WagerTransactionProcessed.from(
    WagerTransactionMapper.toDomain(record),
    {
      eventId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      occurredAt: new Date(),
    },
  );

  return OutboxMessage.enqueue(event);
}

test("persiste payload exato e estado de publicação da outbox", async () => {
  const message = await outboxForPersistenceTest();
  const now = message.occurredAt;

  message.scheduleRetry(now);

  const writer = orm.em.fork({ schema });

  writer.persist(OutboxMessageMapper.toRecord(message));
  await writer.flush();

  const reader = orm.em.fork({ schema });

  const loaded = await reader.findOneOrFail(OutboxMessageRecord, {
    id: message.id,
  });

  const restored = OutboxMessageMapper.toDomain(loaded);

  expect(restored.payload).toEqual(message.payload);
  expect(restored.attempts).toBe(1);
  expect(restored.nextAttemptAt).toEqual(new Date(now.getTime() + 1_000));
  expect(restored.publishedAt).toBeUndefined();

  expect(restored.payload).toMatchObject({
    data: {
      money: {
        amount: "999999999999999999.99",
        currency: "BRL",
      },
    },
  });

  const publishedAt = new Date(now.getTime() + 5_000);

  restored.markPublished(publishedAt);

  loaded.publishedAt = restored.publishedAt ?? null;
  loaded.nextAttemptAt = restored.nextAttemptAt ?? null;

  await reader.flush();

  const published = await orm.em
    .fork({ schema })
    .findOneOrFail(OutboxMessageRecord, { id: message.id });

  expect(published.publishedAt).toEqual(publishedAt);
  expect(published.nextAttemptAt).toBeNull();
  expect(published.attempts).toBe(1);
});

test.each([
  {
    assignment: "attempts = -1",
    constraint: "outbox_messages_attempts_nonnegative",
  },
  {
    assignment: "payload = '{}'::jsonb",
    constraint: "outbox_messages_payload_envelope",
  },
  {
    assignment: "published_at = now(), next_attempt_at = now()",
    constraint: "outbox_messages_published_schedule_consistent",
  },
])("protege as constraints da outbox: %j", async (scenario) => {
  const message = await outboxForPersistenceTest();
  const writer = orm.em.fork({ schema });

  writer.persist(OutboxMessageMapper.toRecord(message));
  await writer.flush();

  await expect(
    writer.execute(
      `
      update "${schema}".outbox_messages
      set ${scenario.assignment}
      where id = ?
    `,
      [message.id],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: scenario.constraint,
  });
});

test("reverte a outbox preservando a operação financeira", async () => {
  const message = await outboxForPersistenceTest();
  const writer = orm.em.fork({ schema });

  writer.persist(OutboxMessageMapper.toRecord(message));
  await writer.flush();

  await orm.migrator.down({
    schema,
    to: "Migration20261029000300",
  });

  const reader = orm.em.fork({ schema });

  const removed = await reader.execute<{ name: string | null }[]>(
    "select to_regclass(?)::text as name",
    [`${schema}.outbox_messages`],
  );

  expect(removed[0]?.name).toBeNull();

  const transaction = await reader.findOneOrFail(WagerTransactionRecord, {
    id: message.aggregateId,
  });

  const wallet = await reader.findOneOrFail(WalletRecord, {
    id: transaction.walletId,
  });

  expect(wallet.balance).toBe("999999999999999999.99");

  expect(
    await reader.count(WalletLedgerEntryRecord, {
      transactionId: transaction.id,
    }),
  ).toBe(1);

  await orm.migrator.up({ schema });

  const restored = await reader.execute<{ name: string | null }[]>(
    "select to_regclass(?)::text as name",
    [`${schema}.outbox_messages`],
  );

  expect(typeof restored[0]?.name).toBe("string");
}, 30_000);

async function outboxEventsForTransaction(transactionId: string) {
  return orm.em.fork({ schema }).execute<
    {
      id: string;
      event_type: string;
      payload: Record<string, unknown>;
    }[]
  >(
    `
      select id, event_type, payload
      from "${schema}".outbox_messages
      where payload -> 'data' ->> 'transactionId' = ?
      order by id
    `,
    [transactionId],
  );
}

test("grava os eventos financeiros e os preserva no replay", async () => {
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

  await processor.process(bet, undefined, {
    correlationId: "request-original",
    causationId: "message-original",
  });

  const events = await outboxEventsForTransaction(bet.id);

  expect(events).toHaveLength(2);

  expect(events.map((event) => event.event_type).sort()).toEqual([
    "WagerTransactionProcessed",
    "WalletBalanceChanged",
  ]);

  for (const event of events) {
    expect(event.payload).toMatchObject({
      correlationId: "request-original",
      causationId: "message-original",
      data: { transactionId: bet.id },
    });
  }

  const replay = await processor.process(
    { ...bet, id: crypto.randomUUID() },
    undefined,
    { correlationId: "request-retry" },
  );

  expect(replay.idempotentReplay).toBe(true);

  expect(await outboxEventsForTransaction(bet.id)).toEqual(events);

  await expectLedgerMatchesWallet(wallet.id);
});

test.each([
  {
    kind: WagerTransactionKind.Loss,
    amount: "0.00",
    status: WagerTransactionStatus.Processed,
    eventType: "WagerTransactionProcessed",
  },
  {
    kind: WagerTransactionKind.Bet,
    amount: "25.00",
    status: WagerTransactionStatus.Rejected,
    eventType: "WagerTransactionRejected",
  },
])(
  "operação sem movimentação gera somente seu resultado: %j",
  async (scenario) => {
    const wallet = await emptyWalletForWagerTest();

    const processor = new PostgresWagerProcessor(orm.em.fork({ schema }));

    const props = wagerPropsForTest(wallet, {
      kind: scenario.kind,
      money: Money.from({
        amount: scenario.amount,
        currency: "BRL",
      }),
    });

    const result = await processor.process(props);
    const events = await outboxEventsForTransaction(props.id);

    expect(result.status).toBe(scenario.status);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe(scenario.eventType);

    const reader = orm.em.fork({ schema });

    const storedWallet = await reader.findOneOrFail(WalletRecord, {
      id: wallet.id,
    });

    expect(storedWallet.balance).toBe("0.00");
    expect(storedWallet.version).toBe(1);

    expect(
      await reader.count(WalletLedgerEntryRecord, { walletId: wallet.id }),
    ).toBe(0);

    await expectLedgerMatchesWallet(wallet.id);
  },
);

test("falha na outbox desfaz a operação financeira", async () => {
  const wallet = await emptyWalletForWagerTest();

  const processor = new PostgresWagerProcessor(orm.em.fork({ schema }));

  const funding = wagerPropsForTest(wallet, {
    kind: WagerTransactionKind.Win,
    money: Money.from({
      amount: "100.00",
      currency: "BRL",
    }),
  });

  await processor.process(funding);

  const bet = wagerPropsForTest(wallet);
  const control = orm.em.fork({ schema });

  // O ID foi gerado pelo próprio teste com crypto.randomUUID().
  await control.execute(`
    alter table "${schema}".outbox_messages
    add constraint outbox_test_failure
    check (aggregate_id <> '${bet.id}'::uuid)
  `);

  try {
    await expect(processor.process(bet)).rejects.toMatchObject({
      code: "23514",
      constraint: "outbox_test_failure",
    });
  } finally {
    await control.execute(`
      alter table "${schema}".outbox_messages
      drop constraint outbox_test_failure
    `);
  }

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
    await reader.count(WalletLedgerEntryRecord, { transactionId: bet.id }),
  ).toBe(0);

  expect(await outboxEventsForTransaction(bet.id)).toHaveLength(0);

  expect(await outboxEventsForTransaction(funding.id)).toHaveLength(2);

  await expectLedgerMatchesWallet(wallet.id);
});

function inboxRecordForTest(): InboxMessageRecord {
  return InboxMessageMapper.toRecord(
    InboxMessage.receive(
      {
        consumerName: "wager-consumer",
        messageId: crypto.randomUUID(),
        payloadHash: "test-hash",
      },
      new Date("2026-10-29T12:00:00.000Z"),
    ),
  );
}

async function insertInboxForTest(record: InboxMessageRecord): Promise<void> {
  await orm.em.fork({ schema }).execute(
    `
      insert into "${schema}".inbox_messages (
        consumer_name, message_id, payload_hash,
        received_at, processed_at
      )
      values (?, ?, ?, ?, ?)
    `,
    [
      record.consumerName,
      record.messageId,
      record.payloadHash,
      record.receivedAt,
      record.processedAt,
    ],
  );
}

test("persiste a identidade composta e a conclusão da inbox", async () => {
  const original = inboxRecordForTest();
  const writer = orm.em.fork({ schema });

  writer.persist(original);
  await writer.flush();

  const reader = orm.em.fork({ schema });

  const loaded = await reader.findOneOrFail(InboxMessageRecord, {
    consumerName: original.consumerName,
    messageId: original.messageId,
  });

  const message = InboxMessageMapper.toDomain(loaded);

  expect(message.consumerName).toBe(original.consumerName);
  expect(message.messageId).toBe(original.messageId);
  expect(message.payloadHash).toBe(original.payloadHash);
  expect(message.receivedAt).toEqual(original.receivedAt);
  expect(message.isProcessed()).toBe(false);
  expect(loaded.processedAt).toBeNull();

  const at = new Date("2026-10-29T12:00:01.000Z");

  message.markProcessed(at);
  loaded.processedAt = message.processedAt ?? null;

  await reader.flush();

  const finalized = InboxMessageMapper.toDomain(
    await orm.em.fork({ schema }).findOneOrFail(InboxMessageRecord, {
      consumerName: original.consumerName,
      messageId: original.messageId,
    }),
  );

  expect(finalized.isProcessed()).toBe(true);
  expect(finalized.processedAt).toEqual(at);
  expect(finalized.receivedAt).toEqual(original.receivedAt);
});

test("impede repetir a entrega para o mesmo consumidor", async () => {
  const record = inboxRecordForTest();

  await insertInboxForTest(record);

  await expect(
    insertInboxForTest({
      ...record,
      payloadHash: "different-hash",
    }),
  ).rejects.toMatchObject({
    code: "23505",
    constraint: "inbox_messages_pkey",
  });
});

test("permite o mesmo messageId para consumidores diferentes", async () => {
  const record = inboxRecordForTest();

  await insertInboxForTest(record);

  await insertInboxForTest({
    ...record,
    consumerName: "another-consumer",
  });

  expect(
    await orm.em
      .fork({ schema })
      .count(InboxMessageRecord, { messageId: record.messageId }),
  ).toBe(2);
});

test.each(["consumerName", "messageId", "payloadHash"] as const)(
  "banco rejeita campo vazio na inbox: %s",
  async (field) => {
    const record = inboxRecordForTest();

    // Altera o record para testar a barreira do banco diretamente.
    record[field] = "";

    await expect(insertInboxForTest(record)).rejects.toMatchObject({
      code: "23514",
      constraint: "inbox_messages_required_values",
    });
  },
);

test("reverte a inbox preservando finanças e outbox", async () => {
  const wallet = await emptyWalletForWagerTest();

  const processor = new PostgresWagerProcessor(orm.em.fork({ schema }));

  const funding = wagerPropsForTest(wallet, {
    kind: WagerTransactionKind.Win,
    money: Money.from({
      amount: "100.00",
      currency: "BRL",
    }),
  });

  await processor.process(funding);

  const inbox = inboxRecordForTest();
  await insertInboxForTest(inbox);

  await orm.migrator.down({
    schema,
    to: "Migration20261029000400",
  });

  const reader = orm.em.fork({ schema });

  const removed = await reader.execute<{ name: string | null }[]>(
    "select to_regclass(?)::text as name",
    [`${schema}.inbox_messages`],
  );

  expect(removed[0]?.name).toBeNull();

  const storedWallet = await reader.findOneOrFail(WalletRecord, {
    id: wallet.id,
  });

  expect(storedWallet.balance).toBe("100.00");

  expect(await outboxEventsForTransaction(funding.id)).toHaveLength(2);

  await expectLedgerMatchesWallet(wallet.id);

  await orm.migrator.up({ schema });

  expect(
    await orm.em.fork({ schema }).count(InboxMessageRecord, {
      consumerName: inbox.consumerName,
      messageId: inbox.messageId,
    }),
  ).toBe(0);
}, 30_000);

async function inboxScenarioForTest() {
  const wallet = await emptyWalletForWagerTest();

  const funding = wagerPropsForTest(wallet, {
    kind: WagerTransactionKind.Win,
    money: Money.from({
      amount: "100.00",
      currency: "BRL",
    }),
  });

  await new PostgresWagerProcessor(orm.em.fork({ schema })).process(funding);

  return {
    walletId: wallet.id,
    funding,
    bet: wagerPropsForTest(wallet),
    delivery: {
      consumerName: "wager-consumer",
      messageId: crypto.randomUUID(),
    },
    consumer: new PostgresInboxWagerProcessor(orm.em.fork({ schema })),
  };
}

test("inbox confirma uma entrega e protege seus reenvios", async () => {
  const { walletId, bet, delivery, consumer } = await inboxScenarioForTest();

  const first = await consumer.process(delivery, bet);

  expect(first.status).toBe(WagerTransactionStatus.Processed);
  expect(first.idempotentReplay).toBe(false);

  const before = await orm.em
    .fork({ schema })
    .findOneOrFail(InboxMessageRecord, delivery);

  expect(before.processedAt).not.toBeNull();
  expect(before.payloadHash).toMatch(/^[0-9a-f]{64}$/);

  const originalEvents = await outboxEventsForTransaction(bet.id);

  const replay = await consumer.process(delivery, {
    ...bet,
    id: crypto.randomUUID(),
  });

  expect(replay).toEqual({
    ...first,
    idempotentReplay: true,
  });

  const changedRequests = [
    {
      ...bet,
      id: crypto.randomUUID(),
      money: Money.from({
        amount: "26.00",
        currency: "BRL",
      }),
    },
    {
      ...bet,
      id: crypto.randomUUID(),
      idempotencyKey: `another:${crypto.randomUUID()}`,
    },
  ];

  for (const changed of changedRequests) {
    await expect(consumer.process(delivery, changed)).rejects.toBeInstanceOf(
      InboxPayloadConflictError,
    );
  }

  const after = await orm.em
    .fork({ schema })
    .findOneOrFail(InboxMessageRecord, delivery);

  expect(after.receivedAt).toEqual(before.receivedAt);
  expect(after.processedAt).toEqual(before.processedAt);
  expect(after.payloadHash).toBe(before.payloadHash);

  // Uma entrega diferente pode apontar para a mesma aposta.
  const anotherDelivery = {
    ...delivery,
    messageId: crypto.randomUUID(),
  };

  const anotherReplay = await consumer.process(anotherDelivery, {
    ...bet,
    id: crypto.randomUUID(),
  });

  expect(anotherReplay.idempotentReplay).toBe(true);

  const reader = orm.em.fork({ schema });

  const anotherInbox = await reader.findOneOrFail(
    InboxMessageRecord,
    anotherDelivery,
  );

  expect(anotherInbox.processedAt).not.toBeNull();

  const wallet = await reader.findOneOrFail(WalletRecord, { id: walletId });

  expect(wallet.balance).toBe("75.00");
  expect(wallet.version).toBe(3);

  expect(
    await reader.count(WalletLedgerEntryRecord, {
      walletId,
      direction: LedgerDirection.Debit,
    }),
  ).toBe(1);

  expect(await outboxEventsForTransaction(bet.id)).toEqual(originalEvents);

  await expectLedgerMatchesWallet(walletId);
});

test("falha ao concluir a inbox desfaz finanças e outbox", async () => {
  const { walletId, funding, bet, delivery, consumer } =
    await inboxScenarioForTest();

  const control = orm.em.fork({ schema });

  // Permite inserir a entrega, mas impede concluir seu processamento.
  await control.execute(`
    alter table "${schema}".inbox_messages
    add constraint inbox_test_failure
    check (
      message_id <> '${delivery.messageId}'
      or processed_at is null
    )
  `);

  try {
    await expect(consumer.process(delivery, bet)).rejects.toMatchObject({
      code: "23514",
      constraint: "inbox_test_failure",
    });
  } finally {
    await control.execute(`
      alter table "${schema}".inbox_messages
      drop constraint inbox_test_failure
    `);
  }

  const reader = orm.em.fork({ schema });

  expect(await reader.findOne(InboxMessageRecord, delivery)).toBeNull();

  expect(
    await reader.findOne(WagerTransactionRecord, { id: bet.id }),
  ).toBeNull();

  expect(
    await reader.count(WalletLedgerEntryRecord, { transactionId: bet.id }),
  ).toBe(0);

  expect(await outboxEventsForTransaction(bet.id)).toHaveLength(0);

  expect(await outboxEventsForTransaction(funding.id)).toHaveLength(2);

  const wallet = await reader.findOneOrFail(WalletRecord, { id: walletId });

  expect(wallet.balance).toBe("100.00");
  expect(wallet.version).toBe(2);

  await expectLedgerMatchesWallet(walletId);

  // Após remover a falha, a mesma entrega pode ser processada.
  const retried = await consumer.process(delivery, bet);

  expect(retried.status).toBe(WagerTransactionStatus.Processed);
  expect(retried.idempotentReplay).toBe(false);

  const finalReader = orm.em.fork({ schema });

  const finalWallet = await finalReader.findOneOrFail(WalletRecord, {
    id: walletId,
  });

  const finalInbox = await finalReader.findOneOrFail(
    InboxMessageRecord,
    delivery,
  );

  expect(finalWallet.balance).toBe("75.00");
  expect(finalWallet.version).toBe(3);
  expect(finalInbox.processedAt).not.toBeNull();

  expect(await outboxEventsForTransaction(bet.id)).toHaveLength(2);

  await expectLedgerMatchesWallet(walletId);
});

test("dez reenvios paralelos da mesma entrega produzem um débito", async () => {
  const { walletId, bet, delivery } = await inboxScenarioForTest();

  const attempts = await Promise.allSettled(
    Array.from({ length: 10 }, () => {
      const consumer = new PostgresInboxWagerProcessor(orm.em.fork({ schema }));

      return consumer.process(delivery, {
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

  expect(results).toHaveLength(10);

  expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);

  expect(results.filter((result) => result.idempotentReplay)).toHaveLength(9);

  expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);

  expect(
    results.every(
      (result) => result.status === WagerTransactionStatus.Processed,
    ),
  ).toBe(true);

  const transactionId = results[0]!.transactionId;
  const reader = orm.em.fork({ schema });

  expect(await reader.count(InboxMessageRecord, delivery)).toBe(1);

  const inbox = await reader.findOneOrFail(InboxMessageRecord, delivery);

  expect(inbox.processedAt).not.toBeNull();

  const wallet = await reader.findOneOrFail(WalletRecord, { id: walletId });

  expect(wallet.balance).toBe("75.00");
  expect(wallet.version).toBe(3);

  expect(
    await reader.count(WalletLedgerEntryRecord, {
      walletId,
      direction: LedgerDirection.Debit,
    }),
  ).toBe(1);

  expect(await outboxEventsForTransaction(transactionId)).toHaveLength(2);

  await expectLedgerMatchesWallet(walletId);
}, 30_000);

test("entregas distintas concorrentes compartilham o resultado financeiro", async () => {
  const { walletId, bet, delivery } = await inboxScenarioForTest();

  const deliveries = [
    delivery,
    {
      ...delivery,
      messageId: crypto.randomUUID(),
    },
  ];

  const attempts = await Promise.allSettled(
    deliveries.map((currentDelivery) => {
      const consumer = new PostgresInboxWagerProcessor(orm.em.fork({ schema }));

      return consumer.process(currentDelivery, {
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

  expect(results).toHaveLength(2);

  expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);

  expect(results.filter((result) => result.idempotentReplay)).toHaveLength(1);

  expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);

  const reader = orm.em.fork({ schema });

  const inboxes = await reader.find(InboxMessageRecord, {
    consumerName: delivery.consumerName,
    messageId: {
      $in: deliveries.map((item) => item.messageId),
    },
  });

  expect(inboxes).toHaveLength(2);
  expect(inboxes.every((inbox) => inbox.processedAt !== null)).toBe(true);

  const wallet = await reader.findOneOrFail(WalletRecord, { id: walletId });

  expect(wallet.balance).toBe("75.00");
  expect(wallet.version).toBe(3);

  expect(
    await outboxEventsForTransaction(results[0]!.transactionId),
  ).toHaveLength(2);

  await expectLedgerMatchesWallet(walletId);
}, 30_000);

test("rejeição por saldo insuficiente conclui a inbox", async () => {
  const wallet = await emptyWalletForWagerTest();

  const consumer = new PostgresInboxWagerProcessor(orm.em.fork({ schema }));

  const delivery = {
    consumerName: "wager-consumer",
    messageId: crypto.randomUUID(),
  };

  const bet = wagerPropsForTest(wallet);

  const result = await consumer.process(delivery, bet);

  expect(result.status).toBe(WagerTransactionStatus.Rejected);
  expect(result.failureCode).toBe(FailureCode.InsufficientBalance);

  const reader = orm.em.fork({ schema });

  const inbox = await reader.findOneOrFail(InboxMessageRecord, delivery);

  expect(inbox.processedAt).not.toBeNull();

  expect(
    await reader.count(WalletLedgerEntryRecord, { walletId: wallet.id }),
  ).toBe(0);

  const events = await outboxEventsForTransaction(bet.id);

  expect(events).toHaveLength(1);
  expect(events[0]?.event_type).toBe("WagerTransactionRejected");

  await expectLedgerMatchesWallet(wallet.id);
});
