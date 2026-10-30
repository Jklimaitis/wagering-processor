import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { MAX_REFERENCE_ATTEMPTS } from "../../src/application/reference-retry-policy";
import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wager-transaction";
import config from "../../src/infrastructure/database/mikro-orm.config";
import {
  PostgresWagerProcessor,
  type PendingReferenceResult,
  type ProcessWagerProps,
} from "../../src/infrastructure/database/postgres-wager-processor";
import { OutboxMessageRecord } from "../../src/infrastructure/database/outbox-message-record";
import { WagerTransactionRecord } from "../../src/infrastructure/database/wager-transaction-record";
import { WalletLedgerEntryRecord } from "../../src/infrastructure/database/wallet-ledger-entry-record";
import { WalletMapper } from "../../src/infrastructure/database/wallet-mapper";
import { WalletRecord } from "../../src/infrastructure/database/wallet-record";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

let orm: MikroORM;
let schema = "";

beforeAll(async () => {
  orm = await MikroORM.init({
    ...config,
    migrations: {
      ...config.migrations,
      snapshot: false,
    },
  });

  await orm.connect();
}, 30_000);

beforeEach(async () => {
  schema = `reference_${crypto.randomUUID().replaceAll("-", "")}`;

  await orm.em.fork().execute(`create schema "${schema}"`);
  await orm.migrator.up({ schema });
}, 30_000);

afterEach(async () => {
  if (schema !== "") {
    await orm.em.fork().execute(`drop schema if exists "${schema}" cascade`);
    schema = "";
  }
}, 30_000);

afterAll(async () => {
  if (orm) {
    await orm.close(true);
  }
});

function em() {
  return orm.em.fork({ schema });
}

function wager(wallet: Wallet, kind: WagerTransactionKind): ProcessWagerProps {
  const id = crypto.randomUUID();

  return {
    id,
    providerId: "reference-test",
    externalTransactionId: id,
    idempotencyKey: `reference-test:${id}`,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: Money.from({ amount: "25.00", currency: "BRL" }),
  };
}

async function scenario(
  kind: WagerTransactionKind = WagerTransactionKind.Refund,
) {
  const wallet = Wallet.open({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    initialBalance: Money.zero("BRL"),
  });

  const writer = em();
  writer.persist(WalletMapper.toRecord(wallet));
  await writer.flush();

  const processor = new PostgresWagerProcessor(em());

  await processor.process({
    ...wager(wallet, WagerTransactionKind.Win),
    money: Money.from({ amount: "100.00", currency: "BRL" }),
  });

  const bet = wager(wallet, WagerTransactionKind.Bet);

  const dependent = {
    ...wager(wallet, kind),
    referenceExternalTransactionId: bet.externalTransactionId,
  };

  const context = {
    correlationId: crypto.randomUUID(),
    causationId: crypto.randomUUID(),
  };

  const initial = await processor.process(dependent, undefined, context);

  expect(initial.status).toBe(WagerTransactionStatus.PendingReference);

  const stored = await em().findOneOrFail(WagerTransactionRecord, {
    id: dependent.id,
  });

  if (stored.nextReferenceAttemptAt === null) {
    throw new Error("Pendência sem agendamento.");
  }

  return {
    wallet,
    processor,
    bet,
    dependent,
    context,
    dueAt: new Date(stored.nextReferenceAttemptAt.getTime()),
  };
}

async function expectFinancialState(
  walletId: string,
  balance: string,
  entries: number,
) {
  const reader = em();

  const wallet = await reader.findOneOrFail(WalletRecord, {
    id: walletId,
  });

  const totals = await reader.execute<{ balance: string }[]>(
    `
      select coalesce(
        sum(case when direction = 'CREDIT' then amount else -amount end),
        0
      )::numeric(20, 2)::text as balance
      from "${schema}".wallet_ledger_entries
      where wallet_id = ?
    `,
    [walletId],
  );

  expect(wallet.balance).toBe(balance);
  expect(totals[0]?.balance).toBe(wallet.balance);
  expect(await reader.count(WalletLedgerEntryRecord, { walletId })).toBe(
    entries,
  );
}

test.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
  "retoma %s recebido antes da BET, uma única vez",
  async (kind) => {
    const setup = await scenario(kind);

    expect(
      await setup.processor.reprocessNextPendingReference(
        new Date(setup.dueAt.getTime() - 1),
      ),
    ).toEqual({ status: "IDLE" });

    await setup.processor.process(setup.bet);

    const results = await Promise.all([
      setup.processor.reprocessNextPendingReference(setup.dueAt),
      new PostgresWagerProcessor(em()).reprocessNextPendingReference(
        setup.dueAt,
      ),
    ]);

    expect(results.filter((r) => r.status === "COMPLETED")).toHaveLength(1);
    expect(results.filter((r) => r.status === "IDLE")).toHaveLength(1);

    const completed = results.find((r) => r.status === "COMPLETED");

    if (completed?.status !== "COMPLETED") {
      throw new Error("Pendência não foi concluída.");
    }

    expect(completed.result.transactionId).toBe(setup.dependent.id);
    expect(completed.result.status).toBe(WagerTransactionStatus.Processed);

    const stored = await em().findOneOrFail(WagerTransactionRecord, {
      id: setup.dependent.id,
    });

    expect(stored.referenceAttempts).toBe(1);
    expect(stored.referenceTransactionId).toBe(setup.bet.id);
    expect(stored.nextReferenceAttemptAt).toBeNull();
    expect(stored.correlationId).toBe(setup.context.correlationId);

    expect(
      await setup.processor.reprocessNextPendingReference(setup.dueAt),
    ).toEqual({ status: "IDLE" });

    const events = await em().find(OutboxMessageRecord, {
      aggregateId: setup.dependent.id,
    });

    expect(events.map((event) => event.eventType).sort()).toEqual(
      ["WagerTransactionPendingReference", "WagerTransactionProcessed"].sort(),
    );

    await expectFinancialState(setup.wallet.id, "100.00", 3);
  },
);

test("reagenda a referência ausente com contador persistente", async () => {
  const setup = await scenario();

  const result = await setup.processor.reprocessNextPendingReference(
    setup.dueAt,
  );

  if (result.status !== "RESCHEDULED") {
    throw new Error("Era esperado um reagendamento.");
  }

  expect(result.attempts).toBe(1);
  expect(result.nextAttemptAt.getTime()).toBe(setup.dueAt.getTime() + 2_000);

  const stored = await em().findOneOrFail(WagerTransactionRecord, {
    id: setup.dependent.id,
  });

  expect(stored.referenceAttempts).toBe(1);
  expect(stored.nextReferenceAttemptAt).toEqual(result.nextAttemptAt);

  expect(
    await new PostgresWagerProcessor(em()).reprocessNextPendingReference(
      setup.dueAt,
    ),
  ).toEqual({ status: "IDLE" });

  expect(
    await em().count(OutboxMessageRecord, {
      aggregateId: setup.dependent.id,
    }),
  ).toBe(1);

  await expectFinancialState(setup.wallet.id, "100.00", 1);
});

test("esgotamento rejeita a pendência e produz um único evento final", async () => {
  const setup = await scenario();
  let at = setup.dueAt;
  let result: PendingReferenceResult | undefined;

  for (let attempt = 0; attempt < MAX_REFERENCE_ATTEMPTS; attempt += 1) {
    result = await new PostgresWagerProcessor(
      em(),
    ).reprocessNextPendingReference(at);

    if (result.status === "RESCHEDULED") {
      at = result.nextAttemptAt;
    } else {
      break;
    }
  }

  if (result?.status !== "COMPLETED") {
    throw new Error("Pendência não terminou após o limite.");
  }

  expect(result.attempts).toBe(MAX_REFERENCE_ATTEMPTS);
  expect(result.result.status).toBe(WagerTransactionStatus.Rejected);
  expect(result.result.failureCode).toBe(FailureCode.ReferenceNotFound);

  const events = await em().find(OutboxMessageRecord, {
    aggregateId: setup.dependent.id,
  });

  expect(events.map((event) => event.eventType).sort()).toEqual(
    ["WagerTransactionPendingReference", "WagerTransactionRejected"].sort(),
  );

  await expectFinancialState(setup.wallet.id, "100.00", 1);
});

test("falha na outbox desfaz a retomada e preserva o agendamento", async () => {
  const setup = await scenario();
  await setup.processor.process(setup.bet);

  await em().execute(`
    alter table "${schema}".outbox_messages
    add constraint reference_outbox_test_failure
    check (
      aggregate_id <> '${setup.dependent.id}'::uuid
      or event_type <> 'WagerTransactionProcessed'
    )
  `);

  try {
    await expect(
      setup.processor.reprocessNextPendingReference(setup.dueAt),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "reference_outbox_test_failure",
    });
  } finally {
    await em().execute(`
      alter table "${schema}".outbox_messages
      drop constraint reference_outbox_test_failure
    `);
  }

  const pending = await em().findOneOrFail(WagerTransactionRecord, {
    id: setup.dependent.id,
  });

  expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
  expect(pending.referenceAttempts).toBe(0);
  expect(pending.nextReferenceAttemptAt).toEqual(setup.dueAt);

  await expectFinancialState(setup.wallet.id, "75.00", 2);

  const retried = await setup.processor.reprocessNextPendingReference(
    setup.dueAt,
  );

  expect(retried.status).toBe("COMPLETED");

  await expectFinancialState(setup.wallet.id, "100.00", 3);
});

test("worker agendado retoma a pendência e encerra com SIGTERM", async () => {
  const setup = await scenario();
  await setup.processor.process(setup.bet);

  const workerPath = fileURLToPath(
    new URL("../../src/workers/reference-worker.ts", import.meta.url),
  );

  const worker = Bun.spawn([process.execPath, workerPath], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      DATABASE_SCHEMA: schema,
    },
    timeout: 10_000,
    killSignal: "SIGKILL",
  });

  const stdout = new Response(worker.stdout).text();
  const stderr = new Response(worker.stderr).text();

  try {
    const deadline = performance.now() + 5_000;
    let completed = false;

    while (performance.now() < deadline) {
      const stored = await em().findOneOrFail(WagerTransactionRecord, {
        id: setup.dependent.id,
      });

      if (stored.status === WagerTransactionStatus.Processed) {
        completed = true;
        break;
      }

      if (worker.exitCode !== null || worker.signalCode !== null) {
        throw new Error(
          `Worker encerrou antes de processar: ${await stdout} ${await stderr}`,
        );
      }

      await delay(50);
    }

    expect(completed).toBe(true);

    worker.kill("SIGTERM");

    expect(await worker.exited).toBe(0);

    const output = await stdout;

    expect(output).toContain('"event":"reference_worker_ready"');
    expect(output).toContain('"event":"reference_completed"');
    expect(output).toContain('"event":"reference_worker_stopped"');

    const stored = await em().findOneOrFail(WagerTransactionRecord, {
      id: setup.dependent.id,
    });

    expect(stored.referenceAttempts).toBe(1);
    expect(stored.nextReferenceAttemptAt).toBeNull();

    await expectFinancialState(setup.wallet.id, "100.00", 3);
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) {
      worker.kill("SIGKILL");
    }

    await Promise.allSettled([worker.exited, stdout, stderr]);
  }
}, 20_000);
