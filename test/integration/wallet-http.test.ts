import "reflect-metadata";
import {
  afterAll,
  beforeAll,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { Module, type INestApplication } from "@nestjs/common";
import { APP_FILTER, NestFactory } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wager-transaction";
import { LedgerDirection } from "../../src/domain/wallet-ledger-entry";
import { HttpExceptionFilter } from "../../src/http-exception.filter";
import { DatabaseService } from "../../src/infrastructure/database/database.service";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { OutboxMessageRecord } from "../../src/infrastructure/database/outbox-message-record";
import type { WalletView } from "../../src/infrastructure/database/postgres-wallet-creator";
import { WagerTransactionRecord } from "../../src/infrastructure/database/wager-transaction-record";
import { WalletLedgerEntryRecord } from "../../src/infrastructure/database/wallet-ledger-entry-record";
import { WalletRecord } from "../../src/infrastructure/database/wallet-record";
import { WalletsController } from "../../src/wallets.controller";
import { WageringController } from "../../src/wagering.controller";
import {
  PostgresWagerProcessor,
  type PostgresWagerResult,
} from "../../src/infrastructure/database/postgres-wager-processor";
import { ProviderTransactionsController } from "../../src/provider-transactions.controller";
import { QueryOrder } from "@mikro-orm/core";
import { encodeLedgerCursor } from "../../src/application/ledger-pagination";
import type { LedgerPageView } from "../../src/infrastructure/database/postgres-financial-reader";
import { MetricsController } from "../../src/metrics.controller";
import { MetricsService } from "../../src/metrics.service";
import { Money } from "../../src/domain/money";
import { CreateQueueCommand, DeleteQueueCommand } from "@aws-sdk/client-sqs";
import { setTimeout as delay } from "node:timers/promises";
import { HealthController } from "../../src/health.controller";
import { ReadinessService } from "../../src/readiness.service";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client";

const schema = `wallet_http_${crypto.randomUUID().replaceAll("-", "")}`;

let orm: MikroORM;
let app: INestApplication | undefined;
let baseUrl = "";

const sqsAdmin = createSqsClient();

const healthQueueNames = ["wagers", "dlq", "events"].map(
  (name) => `health-${name}-${crypto.randomUUID()}.fifo`,
);

const healthQueueUrls: string[] = [];

@Module({
  controllers: [
    HealthController,
    WalletsController,
    WageringController,
    ProviderTransactionsController,
    MetricsController,
  ],
  providers: [
    MetricsService,
    {
      provide: DatabaseService,
      useFactory: () => new DatabaseService({ ...config, schema }),
    },
    {
      provide: ReadinessService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) =>
        new ReadinessService(database, createSqsClient(), healthQueueNames),
    },
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
class TestModule {}

beforeAll(async () => {
  orm = await MikroORM.init({
    ...config,
    schema,
    migrations: {
      ...config.migrations,
      snapshot: false,
    },
  });

  await orm.connect();
  await orm.em.fork().execute(`create schema "${schema}"`);
  await orm.migrator.up({ schema });

  for (const name of healthQueueNames) {
    const created = await sqsAdmin.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "false",
        },
      }),
      { abortSignal: AbortSignal.timeout(10_000) },
    );

    if (created.QueueUrl === undefined) {
      throw new Error("SQS não retornou a URL da fila de health.");
    }

    healthQueueUrls.push(created.QueueUrl);
  }

  await delay(1_000);

  app = await NestFactory.create(TestModule, {
    logger: false,
    abortOnError: false,
  });

  await app.listen(0, "127.0.0.1");
  baseUrl = await app.getUrl();
}, 30_000);

afterAll(async () => {
  try {
    await app?.close();
  } finally {
    try {
      for (const queueUrl of healthQueueUrls) {
        await sqsAdmin.send(new DeleteQueueCommand({ QueueUrl: queueUrl }), {
          abortSignal: AbortSignal.timeout(10_000),
        });
      }
    } finally {
      sqsAdmin.destroy();

      if (orm) {
        try {
          await orm.em
            .fork()
            .execute(`drop schema if exists "${schema}" cascade`);
        } finally {
          await orm.close(true);
        }
      }
    }
  }
}, 30_000);

function postWallet(playerId: string, amount: unknown) {
  return fetch(`${baseUrl}/wallets`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-correlation-id": "wallet-http-test",
    },
    body: JSON.stringify({
      playerId,
      initialBalance: { amount, currency: "BRL" },
    }),
  });
}

function counts() {
  const reader = orm.em.fork();

  return Promise.all([
    reader.count(WalletRecord, {}),
    reader.count(WagerTransactionRecord, {}),
    reader.count(WalletLedgerEntryRecord, {}),
    reader.count(OutboxMessageRecord, {}),
  ]);
}

test.each(["100.00", "0.00"])(
  "cria wallet com saldo %s e versão inicial 1",
  async (amount) => {
    const playerId = crypto.randomUUID();
    const response = await postWallet(playerId, amount);

    expect(response.status).toBe(201);

    const body = (await response.json()) as WalletView;

    expect(body).toEqual({
      id: expect.any(String),
      playerId,
      balance: { amount, currency: "BRL" },
      version: 1,
    });

    const reader = orm.em.fork();

    const stored = await reader.findOneOrFail(WalletRecord, {
      id: body.id,
    });

    expect(stored.balance).toBe(amount);
    expect(stored.version).toBe(1);

    if (amount === "0.00") {
      expect(
        await reader.count(WagerTransactionRecord, {
          walletId: body.id,
        }),
      ).toBe(0);

      expect(
        await reader.count(WalletLedgerEntryRecord, {
          walletId: body.id,
        }),
      ).toBe(0);

      expect(
        await reader.count(OutboxMessageRecord, {
          aggregateId: body.id,
        }),
      ).toBe(0);

      return;
    }

    const opening = await reader.findOneOrFail(WagerTransactionRecord, {
      walletId: body.id,
    });

    expect(opening.kind).toBe(WagerTransactionKind.Opening);
    expect(opening.status).toBe(WagerTransactionStatus.Processed);
    expect(opening.resultBalance).toBe(amount);
    expect(opening.correlationId).toBe("wallet-http-test");

    const entry = await reader.findOneOrFail(WalletLedgerEntryRecord, {
      walletId: body.id,
    });

    expect(entry.transactionId).toBe(opening.id);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.amount).toBe(stored.balance);
    expect(entry.balanceBefore).toBe("0.00");
    expect(entry.balanceAfter).toBe(stored.balance);

    const events = await reader.find(OutboxMessageRecord, {
      aggregateId: { $in: [body.id, opening.id] },
    });

    expect(events.map((event) => event.eventType).sort()).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);

    for (const event of events) {
      expect(event.publishedAt).toBeNull();
      expect(event.payload.correlationId).toBe("wallet-http-test");
    }
  },
);

test("rejeita dinheiro recebido como number antes de persistir", async () => {
  const before = await counts();

  const response = await postWallet(crypto.randomUUID(), 100);

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    code: "INVALID_INPUT",
    field: "initialBalance.amount",
  });

  expect(await counts()).toEqual(before);
});

test("duas criações concorrentes produzem uma wallet e um conflito", async () => {
  const playerId = crypto.randomUUID();

  const responses = await Promise.all([
    postWallet(playerId, "100.00"),
    postWallet(playerId, "100.00"),
  ]);

  expect(responses.map((response) => response.status).sort()).toEqual([
    201, 409,
  ]);

  const conflict = responses.find((response) => response.status === 409);

  expect(await conflict?.json()).toMatchObject({
    code: "WALLET_ALREADY_EXISTS",
  });

  const reader = orm.em.fork();

  expect(await reader.count(WalletRecord, { playerId })).toBe(1);
  expect(await reader.count(WagerTransactionRecord, { playerId })).toBe(1);

  const wallet = await reader.findOneOrFail(WalletRecord, { playerId });

  expect(wallet.balance).toBe("100.00");
  expect(wallet.version).toBe(1);

  expect(
    await reader.count(WalletLedgerEntryRecord, {
      walletId: wallet.id,
    }),
  ).toBe(1);
});

test("falha na outbox desfaz wallet, OPENING e ledger", async () => {
  const playerId = crypto.randomUUID();
  const before = await counts();

  await orm.em.fork().execute(`
    alter table "${schema}".outbox_messages
    add constraint wallet_http_force_failure
    check (
      event_type <> 'WagerTransactionProcessed'
      or payload -> 'data' ->> 'playerId' <> '${playerId}'
    )
  `);

  try {
    const response = await postWallet(playerId, "100.00");

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "INTERNAL_ERROR",
    });

    expect(await counts()).toEqual(before);
  } finally {
    await orm.em.fork().execute(`
      alter table "${schema}".outbox_messages
      drop constraint wallet_http_force_failure
    `);
  }
});

async function createFundedWallet(): Promise<WalletView> {
  const response = await postWallet(crypto.randomUUID(), "100.00");

  expect(response.status).toBe(201);

  return (await response.json()) as WalletView;
}

function wagerRequest(wallet: Pick<WalletView, "id" | "playerId">) {
  return {
    providerId: "http-provider",
    externalTransactionId: crypto.randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: { amount: "25.00", currency: "BRL" },
  };
}

function postWager(body: unknown, key: string | undefined) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-correlation-id": "wager-http-test",
  };

  if (key !== undefined) {
    headers["idempotency-key"] = key;
  }

  return fetch(`${baseUrl}/wagering/transactions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function expectLedgerBalance(walletId: string, expected: string) {
  const reader = orm.em.fork();

  const wallet = await reader.findOneOrFail(WalletRecord, {
    id: walletId,
  });

  const [totals] = await reader.execute<{ balance: string }[]>(
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

  expect(wallet.balance).toBe(expected);
  expect(totals?.balance).toBe(expected);
}

test("header governa a idempotência e replay preserva o saldo original", async () => {
  const wallet = await createFundedWallet();
  const key = `http:${crypto.randomUUID()}`;

  const input = {
    ...wagerRequest(wallet),
    idempotencyKey: "chave-do-body-ignorada",
  };

  const firstResponse = await postWager(input, key);

  expect(firstResponse.status).toBe(200);

  const first = (await firstResponse.json()) as PostgresWagerResult;

  expect(first).toMatchObject({
    status: WagerTransactionStatus.Processed,
    balance: { amount: "75.00", currency: "BRL" },
    idempotentReplay: false,
  });

  const stored = await orm.em
    .fork()
    .findOneOrFail(WagerTransactionRecord, { id: first.transactionId });

  expect(stored.idempotencyKey).toBe(key);

  const winResponse = await postWager(
    {
      ...wagerRequest(wallet),
      kind: WagerTransactionKind.Win,
      money: { amount: "10.00", currency: "BRL" },
    },
    `http:${crypto.randomUUID()}`,
  );

  expect(winResponse.status).toBe(200);

  const beforeReplay = await counts();

  const replayResponse = await postWager(
    {
      ...input,
      idempotencyKey: "outro-valor-ignorado-no-body",
    },
    key,
  );

  expect(replayResponse.status).toBe(200);
  expect(await replayResponse.json()).toEqual({
    ...first,
    idempotentReplay: true,
  });

  for (const conflict of [
    {
      body: {
        ...input,
        money: { amount: "26.00", currency: "BRL" },
      },
      key,
    },
    {
      body: input,
      key: `outra-chave:${crypto.randomUUID()}`,
    },
  ]) {
    const response = await postWager(conflict.body, conflict.key);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
  }

  expect(await counts()).toEqual(beforeReplay);

  await expectLedgerBalance(wallet.id, "85.00");

  expect(
    await orm.em.fork().count(WalletLedgerEntryRecord, {
      walletId: wallet.id,
    }),
  ).toBe(3);
});

test.each([
  ["header ausente", WagerTransactionKind.Bet, undefined, "INVALID_INPUT"],
  [
    "OPENING externo",
    WagerTransactionKind.Opening,
    `invalid:${crypto.randomUUID()}`,
    "INVALID_INPUT",
  ],
  [
    "REFUND sem referência",
    WagerTransactionKind.Refund,
    `invalid:${crypto.randomUUID()}`,
    "INVALID_OPERATION",
  ],
] as const)(
  "retorna 400 para %s sem persistir efeitos",
  async (_description, kind, key, code) => {
    const wallet = await createFundedWallet();
    const before = await counts();

    const response = await postWager(
      {
        ...wagerRequest(wallet),
        kind,
        idempotencyKey: "body-nao-substitui-header",
      },
      key,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code });
    expect(await counts()).toEqual(before);
  },
);

test("rejeição de negócio retorna 422 e permanece auditável", async () => {
  const wallet = await createFundedWallet();

  const response = await postWager(
    {
      ...wagerRequest(wallet),
      money: { amount: "101.00", currency: "BRL" },
    },
    `http:${crypto.randomUUID()}`,
  );

  expect(response.status).toBe(422);

  const result = (await response.json()) as PostgresWagerResult;

  expect(result).toMatchObject({
    status: WagerTransactionStatus.Rejected,
    failureCode: FailureCode.InsufficientBalance,
    balance: { amount: "100.00", currency: "BRL" },
  });

  const reader = orm.em.fork();

  const stored = await reader.findOneOrFail(WagerTransactionRecord, {
    id: result.transactionId,
  });

  expect(stored.status).toBe(WagerTransactionStatus.Rejected);
  expect(stored.failureCode).toBe(FailureCode.InsufficientBalance);

  expect(
    await reader.count(WalletLedgerEntryRecord, {
      transactionId: result.transactionId,
    }),
  ).toBe(0);

  expect(
    await reader.count(OutboxMessageRecord, {
      aggregateId: result.transactionId,
      eventType: "WagerTransactionRejected",
    }),
  ).toBe(1);

  await expectLedgerBalance(wallet.id, "100.00");
});

test("referência ausente retorna 202 com reprocessamento agendado", async () => {
  const wallet = await createFundedWallet();

  const response = await postWager(
    {
      ...wagerRequest(wallet),
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: crypto.randomUUID(),
    },
    `http:${crypto.randomUUID()}`,
  );

  expect(response.status).toBe(202);

  const result = (await response.json()) as PostgresWagerResult;

  expect(result).toMatchObject({
    status: WagerTransactionStatus.PendingReference,
    balance: { amount: "100.00", currency: "BRL" },
    idempotentReplay: false,
  });

  const reader = orm.em.fork();

  const stored = await reader.findOneOrFail(WagerTransactionRecord, {
    id: result.transactionId,
  });

  expect(stored.status).toBe(WagerTransactionStatus.PendingReference);
  expect(stored.nextReferenceAttemptAt).not.toBeNull();

  expect(
    await reader.count(WalletLedgerEntryRecord, {
      transactionId: result.transactionId,
    }),
  ).toBe(0);

  await expectLedgerBalance(wallet.id, "100.00");
});

test("wallet inexistente retorna 404 sem persistir efeitos", async () => {
  const before = await counts();

  const response = await postWager(
    wagerRequest({
      id: crypto.randomUUID(),
      playerId: crypto.randomUUID(),
    }),
    `http:${crypto.randomUUID()}`,
  );

  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({
    code: "NOT_FOUND",
  });

  expect(await counts()).toEqual(before);
});

test("consultas preservam saldo observado e distinguem provedores", async () => {
  const wallet = await createFundedWallet();
  const externalTransactionId = `tx/${crypto.randomUUID()}`;

  const betResponse = await postWager(
    {
      ...wagerRequest(wallet),
      providerId: "query-provider-a",
      externalTransactionId,
    },
    `http:${crypto.randomUUID()}`,
  );

  expect(betResponse.status).toBe(200);

  const bet = (await betResponse.json()) as PostgresWagerResult;

  const winResponse = await postWager(
    {
      ...wagerRequest(wallet),
      providerId: "query-provider-b",
      externalTransactionId,
      kind: WagerTransactionKind.Win,
      money: { amount: "10.00", currency: "BRL" },
    },
    `http:${crypto.randomUUID()}`,
  );

  expect(winResponse.status).toBe(200);

  const win = (await winResponse.json()) as PostgresWagerResult;
  const beforeQueries = await counts();

  const walletResponse = await fetch(`${baseUrl}/wallets/${wallet.id}`);

  expect(walletResponse.status).toBe(200);
  expect(await walletResponse.json()).toEqual({
    id: wallet.id,
    playerId: wallet.playerId,
    balance: { amount: "85.00", currency: "BRL" },
    version: 3,
  });

  const transactionResponse = await fetch(
    `${baseUrl}/wagering/transactions/${bet.transactionId}`,
  );

  expect(transactionResponse.status).toBe(200);

  const transaction = await transactionResponse.json();

  expect(transaction).toMatchObject({
    transactionId: bet.transactionId,
    providerId: "query-provider-a",
    externalTransactionId,
    walletId: wallet.id,
    playerId: wallet.playerId,
    kind: WagerTransactionKind.Bet,
    money: { amount: "25.00", currency: "BRL" },
    status: WagerTransactionStatus.Processed,
    balance: { amount: "75.00", currency: "BRL" },
    failureCode: null,
    referenceExternalTransactionId: null,
    referenceTransactionId: null,
    createdAt: expect.any(String),
    processedAt: expect.any(String),
  });

  expect(transaction).not.toHaveProperty("payloadHash");
  expect(transaction).not.toHaveProperty("idempotencyKey");

  const externalId = encodeURIComponent(externalTransactionId);

  const providerAResponse = await fetch(
    `${baseUrl}/providers/query-provider-a/wagering/transactions/${externalId}`,
  );

  expect(providerAResponse.status).toBe(200);
  expect(await providerAResponse.json()).toEqual(transaction);

  const providerBResponse = await fetch(
    `${baseUrl}/providers/query-provider-b/wagering/transactions/${externalId}`,
  );

  expect(providerBResponse.status).toBe(200);
  expect(await providerBResponse.json()).toMatchObject({
    transactionId: win.transactionId,
    providerId: "query-provider-b",
    externalTransactionId,
    kind: WagerTransactionKind.Win,
    money: { amount: "10.00", currency: "BRL" },
    balance: { amount: "85.00", currency: "BRL" },
  });

  expect(await counts()).toEqual(beforeQueries);
  await expectLedgerBalance(wallet.id, "85.00");
});

test.each([
  `/wallets/${crypto.randomUUID()}`,
  `/wagering/transactions/${crypto.randomUUID()}`,
  `/providers/missing-provider/wagering/transactions/${crypto.randomUUID()}`,
])("consulta inexistente retorna 404: %s", async (path) => {
  const response = await fetch(`${baseUrl}${path}`);

  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({
    code: "NOT_FOUND",
  });
});

test.each([
  ["/wallets/not-a-uuid", "walletId"],
  ["/wagering/transactions/not-a-uuid", "transactionId"],
] as const)(
  "consulta com UUID inválido retorna 400: %s",
  async (path, field) => {
    const response = await fetch(`${baseUrl}${path}`);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "INVALID_INPUT",
      field,
    });
  },
);

async function readLedgerPage(
  walletId: string,
  cursor?: string,
  limit = 2,
): Promise<LedgerPageView> {
  const params = new URLSearchParams({
    limit: String(limit),
  });

  if (cursor !== undefined) {
    params.set("cursor", cursor);
  }

  const response = await fetch(
    `${baseUrl}/wallets/${walletId}/ledger?${params}`,
  );

  expect(response.status).toBe(200);

  return (await response.json()) as LedgerPageView;
}

async function creditOne(wallet: WalletView): Promise<void> {
  const response = await postWager(
    {
      ...wagerRequest(wallet),
      kind: WagerTransactionKind.Win,
      money: { amount: "1.00", currency: "BRL" },
    },
    `http:${crypto.randomUUID()}`,
  );

  expect(response.status).toBe(200);
}

test("pagina empates de horário e inclui inserção posterior sem repetir entradas", async () => {
  const at = new Date("2030-01-01T12:00:00.000Z");

  setSystemTime(at);

  try {
    const wallet = await createFundedWallet();

    await creditOne(wallet);
    await creditOne(wallet);
    await creditOne(wallet);

    // Outra wallet não deve aparecer nas páginas.
    await createFundedWallet();

    const beforeFirstPage = await counts();
    const first = await readLedgerPage(wallet.id);

    expect(first.items).toHaveLength(2);
    expect(first.items[0]?.createdAt).toBe(at.toISOString());
    expect(first.items[1]?.createdAt).toBe(at.toISOString());
    expect(await counts()).toEqual(beforeFirstPage);

    if (first.nextCursor === null) {
      throw new Error("Esperávamos uma segunda página.");
    }

    // Uma nova entrada passa a existir depois da primeira consulta.
    setSystemTime(new Date(at.getTime() + 1_000));
    await creditOne(wallet);

    const beforeRemainingPages = await counts();

    const second = await readLedgerPage(wallet.id, first.nextCursor);

    const repeated = await readLedgerPage(wallet.id, first.nextCursor);

    expect(repeated).toEqual(second);
    expect(second.items).toHaveLength(2);

    if (second.nextCursor === null) {
      throw new Error("Esperávamos uma terceira página.");
    }

    const third = await readLedgerPage(wallet.id, second.nextCursor);

    expect(third.items).toHaveLength(1);
    expect(third.nextCursor).toBeNull();

    const items = [...first.items, ...second.items, ...third.items];

    const expected = await orm.em.fork().find(
      WalletLedgerEntryRecord,
      { walletId: wallet.id },
      {
        orderBy: {
          createdAt: QueryOrder.ASC,
          id: QueryOrder.ASC,
        },
      },
    );

    expect(items.map((item) => item.id)).toEqual(
      expected.map((entry) => entry.id),
    );

    expect(new Set(items.map((item) => item.id)).size).toBe(5);

    for (const item of items) {
      expect(item.walletId).toBe(wallet.id);
      expect(item.money.amount).toMatch(/^\d+\.\d{2}$/);
      expect(item.balanceBefore.amount).toMatch(/^\d+\.\d{2}$/);
      expect(item.balanceAfter.amount).toMatch(/^\d+\.\d{2}$/);
    }

    expect(await counts()).toEqual(beforeRemainingPages);
    await expectLedgerBalance(wallet.id, "104.00");
  } finally {
    setSystemTime();
  }
});

test("wallet sem movimentações retorna ledger vazio", async () => {
  const response = await postWallet(crypto.randomUUID(), "0.00");

  expect(response.status).toBe(201);

  const wallet = (await response.json()) as WalletView;

  const ledgerResponse = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger`);

  expect(ledgerResponse.status).toBe(200);
  expect(await ledgerResponse.json()).toEqual({
    items: [],
    nextCursor: null,
  });

  await expectLedgerBalance(wallet.id, "0.00");
});

test("ledger de wallet inexistente retorna 404", async () => {
  const response = await fetch(
    `${baseUrl}/wallets/${crypto.randomUUID()}/ledger`,
  );

  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({
    code: "NOT_FOUND",
  });
});

test("rejeita limites inválidos e cursores incompatíveis", async () => {
  const origin = await createFundedWallet();
  await creditOne(origin);

  const foreignPage = await readLedgerPage(origin.id, undefined, 1);

  if (foreignPage.nextCursor === null) {
    throw new Error("Esperávamos um cursor para a wallet de origem.");
  }

  const target = await createFundedWallet();
  const before = await counts();

  const unknownEntryCursor = encodeLedgerCursor(target.id, crypto.randomUUID());

  const cases = [
    ["?limit=0", "limit"],
    ["?limit=101", "limit"],
    ["?limit=1.5", "limit"],
    ["?limit=2&limit=3", "limit"],
    ["?cursor=%2B", "cursor"],
    [`?cursor=${encodeURIComponent(foreignPage.nextCursor)}`, "cursor"],
    [`?cursor=${encodeURIComponent(unknownEntryCursor)}`, "cursor"],
  ] as const;

  for (const [query, field] of cases) {
    const response = await fetch(
      `${baseUrl}/wallets/${target.id}/ledger${query}`,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "INVALID_INPUT",
      field,
    });
  }

  expect(await counts()).toEqual(before);

  await expectLedgerBalance(origin.id, "101.00");
  await expectLedgerBalance(target.id, "100.00");
});

function requestReconciliation(walletId: string, signal?: AbortSignal) {
  return fetch(`${baseUrl}/wallets/${walletId}/reconciliation`, {
    method: "POST",
    headers: {
      "x-correlation-id": "reconciliation-test",
    },
    signal,
  });
}

async function reconciliationMetric(
  result: "consistent" | "inconsistent",
): Promise<number> {
  const response = await fetch(`${baseUrl}/metrics`);

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/plain");

  const text = await response.text();

  const sample = text
    .split("\n")
    .find((line) =>
      line.startsWith(`wagering_reconciliations_total{result="${result}"} `),
    );

  if (sample === undefined) {
    throw new Error(`Métrica de reconciliação ausente: ${result}`);
  }

  const value = Number(sample.slice(sample.lastIndexOf(" ") + 1));

  expect(Number.isSafeInteger(value)).toBe(true);

  return value;
}

test.each([
  ["0.00", "0.00", 0],
  ["100.00", "75.00", 2],
] as const)(
  "reconcilia saldo inicial %s sem alterar dados",
  async (initialBalance, expectedBalance, checkedEntries) => {
    const created = await postWallet(crypto.randomUUID(), initialBalance);

    expect(created.status).toBe(201);

    const wallet = (await created.json()) as WalletView;

    if (initialBalance === "100.00") {
      const bet = await postWager(
        wagerRequest(wallet),
        `http:${crypto.randomUUID()}`,
      );

      expect(bet.status).toBe(200);
    }

    const before = await counts();

    const beforeWallet = await orm.em
      .fork()
      .findOneOrFail(WalletRecord, { id: wallet.id });

    const metricBefore = await reconciliationMetric("consistent");

    const response = await requestReconciliation(wallet.id);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      walletId: wallet.id,
      storedBalance: {
        amount: expectedBalance,
        currency: "BRL",
      },
      calculatedBalance: {
        amount: expectedBalance,
        currency: "BRL",
      },
      difference: {
        amount: "0.00",
        currency: "BRL",
      },
      consistent: true,
      checkedEntries,
    });

    const afterWallet = await orm.em
      .fork()
      .findOneOrFail(WalletRecord, { id: wallet.id });

    expect(afterWallet.balance).toBe(beforeWallet.balance);
    expect(afterWallet.version).toBe(beforeWallet.version);
    expect(afterWallet.updatedAt.getTime()).toBe(
      beforeWallet.updatedAt.getTime(),
    );

    expect(await counts()).toEqual(before);

    expect(await reconciliationMetric("consistent")).toBe(metricBefore + 1);

    await expectLedgerBalance(wallet.id, expectedBalance);
  },
);

test.each([
  ["74.99", "-0.01"],
  ["75.01", "0.01"],
] as const)(
  "detecta saldo divergente %s, registra métrica e preserva os dados",
  async (corruptedBalance, difference) => {
    const wallet = await createFundedWallet();

    const bet = await postWager(
      wagerRequest(wallet),
      `http:${crypto.randomUUID()}`,
    );

    expect(bet.status).toBe(200);

    // Simula corrupção do saldo materializado no schema do teste.
    await orm.em
      .fork()
      .nativeUpdate(
        WalletRecord,
        { id: wallet.id },
        { balance: corruptedBalance },
      );

    const before = await counts();
    const metricBefore = await reconciliationMetric("inconsistent");
    const lines: string[] = [];

    const logSpy = spyOn(console, "log").mockImplementation(
      (...values: unknown[]) => {
        for (const value of values) {
          if (typeof value === "string") {
            lines.push(value);
          }
        }
      },
    );

    try {
      const response = await requestReconciliation(wallet.id);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        walletId: wallet.id,
        storedBalance: {
          amount: corruptedBalance,
          currency: "BRL",
        },
        calculatedBalance: {
          amount: "75.00",
          currency: "BRL",
        },
        difference: {
          amount: difference,
          currency: "BRL",
        },
        consistent: false,
        checkedEntries: 2,
      });

      const stored = await orm.em
        .fork()
        .findOneOrFail(WalletRecord, { id: wallet.id });

      expect(stored.balance).toBe(corruptedBalance);
      expect(stored.version).toBe(2);
      expect(await counts()).toEqual(before);

      expect(await reconciliationMetric("inconsistent")).toBe(metricBefore + 1);

      const event = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find(
          (entry) =>
            entry.event === "wallet_reconciliation_mismatch" &&
            entry.walletId === wallet.id,
        );

      expect(event).toMatchObject({
        level: "error",
        correlationId: "reconciliation-test",
        walletId: wallet.id,
        consistent: false,
        checkedEntries: 2,
      });

      expect(event).not.toHaveProperty("storedBalance");
      expect(event).not.toHaveProperty("calculatedBalance");
      expect(event).not.toHaveProperty("difference");
    } finally {
      logSpy.mockRestore();

      await orm.em
        .fork()
        .nativeUpdate(WalletRecord, { id: wallet.id }, { balance: "75.00" });
    }

    await expectLedgerBalance(wallet.id, "75.00");
  },
);

test.each([
  [crypto.randomUUID(), 404, "NOT_FOUND"],
  ["not-a-uuid", 400, "INVALID_INPUT"],
] as const)(
  "reconciliação inválida retorna HTTP %s",
  async (walletId, status, code) => {
    const before = await Promise.all([
      reconciliationMetric("consistent"),
      reconciliationMetric("inconsistent"),
    ]);

    const response = await requestReconciliation(walletId);

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });

    expect(
      await Promise.all([
        reconciliationMetric("consistent"),
        reconciliationMetric("inconsistent"),
      ]),
    ).toEqual(before);
  },
);

test("reconciliação lê estado confirmado enquanto uma aposta aguarda commit", async () => {
  const wallet = await createFundedWallet();

  let notifyReady!: () => void;
  let release!: () => void;

  const ready = new Promise<void>((resolve) => {
    notifyReady = resolve;
  });

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const transaction = orm.em.fork().transactional(async (em) => {
    const result = await new PostgresWagerProcessor(em).process({
      ...wagerRequest(wallet),
      id: crypto.randomUUID(),
      idempotencyKey: `http:${crypto.randomUUID()}`,
      money: Money.from({
        amount: "25.00",
        currency: "BRL",
      }),
    });

    expect(result.status).toBe(WagerTransactionStatus.Processed);

    notifyReady();
    await gate;
  });

  try {
    await Promise.race([
      ready,
      transaction.then(() => {
        throw new Error("Transação terminou antes da barreira.");
      }),
    ]);

    const response = await requestReconciliation(
      wallet.id,
      AbortSignal.timeout(2_000),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      storedBalance: { amount: "100.00", currency: "BRL" },
      calculatedBalance: { amount: "100.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 1,
    });
  } finally {
    release();
    await transaction;
  }

  const response = await requestReconciliation(wallet.id);

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    storedBalance: { amount: "75.00", currency: "BRL" },
    calculatedBalance: { amount: "75.00", currency: "BRL" },
    consistent: true,
    checkedEntries: 2,
  });

  await expectLedgerBalance(wallet.id, "75.00");
}, 10_000);

async function expectHealth(
  path: "live" | "ready",
  status: number,
  body: unknown,
): Promise<void> {
  const response = await fetch(`${baseUrl}/health/${path}`, {
    signal: AbortSignal.timeout(5_000),
  });

  expect(response.status).toBe(status);
  expect(await response.json()).toEqual(body);
}

test("health distingue processo vivo de dependências prontas", async () => {
  if (app === undefined) {
    throw new Error("Aplicação de teste não inicializada.");
  }

  const before = await counts();

  await expectHealth("live", 200, { status: "ok" });

  await expectHealth("ready", 200, {
    status: "ok",
    checks: {
      postgres: "up",
      sqs: "up",
    },
  });

  const database = app.get(DatabaseService);

  // Fecha somente o pool pertencente à API de teste.
  await database.onModuleDestroy();

  try {
    await expectHealth("ready", 503, {
      status: "error",
      checks: {
        postgres: "down",
        sqs: "up",
      },
    });

    await expectHealth("live", 200, { status: "ok" });
  } finally {
    await database.onModuleInit();
  }

  await expectHealth("ready", 200, {
    status: "ok",
    checks: {
      postgres: "up",
      sqs: "up",
    },
  });

  const queueUrl = healthQueueUrls.pop();

  if (queueUrl === undefined) {
    throw new Error("Fila exclusiva de health ausente.");
  }

  await sqsAdmin.send(new DeleteQueueCommand({ QueueUrl: queueUrl }), {
    abortSignal: AbortSignal.timeout(10_000),
  });

  await expectHealth("ready", 503, {
    status: "error",
    checks: {
      postgres: "up",
      sqs: "down",
    },
  });

  await expectHealth("live", 200, { status: "ok" });

  expect(await counts()).toEqual(before);
}, 15_000);

async function httpMetric(sample: string): Promise<number> {
  const response = await fetch(`${baseUrl}/metrics`);

  expect(response.status).toBe(200);

  const line = (await response.text())
    .split("\n")
    .find((value) => value.startsWith(`${sample} `));

  return line === undefined ? 0 : Number(line.slice(line.lastIndexOf(" ") + 1));
}

test("métricas distinguem resultados, replay e conflito com logs rastreáveis", async () => {
  const wallet = await createFundedWallet();

  const samples = {
    processed:
      'wagering_transaction_results_total{source="http",status="PROCESSED"}',
    rejected:
      'wagering_transaction_results_total{source="http",status="REJECTED"}',
    pending:
      'wagering_transaction_results_total{source="http",status="PENDING_REFERENCE"}',
    duplicates: 'wagering_duplicates_total{source="http"}',
    latency: 'wagering_processing_duration_seconds_count{source="http"}',
  };

  const [processed, rejected, pending, duplicates, latency] = await Promise.all(
    [
      httpMetric(samples.processed),
      httpMetric(samples.rejected),
      httpMetric(samples.pending),
      httpMetric(samples.duplicates),
      httpMetric(samples.latency),
    ],
  );

  const lines: string[] = [];

  const logSpy = spyOn(console, "log").mockImplementation(
    (...values: unknown[]) => {
      for (const value of values) {
        if (typeof value === "string") {
          lines.push(value);
        }
      }
    },
  );

  try {
    const input = wagerRequest(wallet);
    const key = `http:${crypto.randomUUID()}`;

    const firstResponse = await postWager(input, key);

    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get("x-correlation-id")).toBe(
      "wager-http-test",
    );

    const first = (await firstResponse.json()) as PostgresWagerResult;

    const replay = await postWager(input, key);

    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      transactionId: first.transactionId,
      idempotentReplay: true,
    });

    const conflict = await postWager(
      {
        ...input,
        money: { amount: "26.00", currency: "BRL" },
      },
      key,
    );

    expect(conflict.status).toBe(409);

    const rejection = await postWager(
      {
        ...wagerRequest(wallet),
        money: { amount: "101.00", currency: "BRL" },
      },
      `http:${crypto.randomUUID()}`,
    );

    expect(rejection.status).toBe(422);

    const pendingResponse = await postWager(
      {
        ...wagerRequest(wallet),
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: crypto.randomUUID(),
      },
      `http:${crypto.randomUUID()}`,
    );

    expect(pendingResponse.status).toBe(202);

    expect(await httpMetric(samples.processed)).toBe(processed + 1);
    expect(await httpMetric(samples.rejected)).toBe(rejected + 1);
    expect(await httpMetric(samples.pending)).toBe(pending + 1);
    expect(await httpMetric(samples.duplicates)).toBe(duplicates + 1);
    expect(await httpMetric(samples.latency)).toBe(latency + 5);

    const events = lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );

    const completion = events.find(
      (event) =>
        event.event === "wager_http_completed" &&
        event.transactionId === first.transactionId &&
        event.idempotentReplay === false,
    );

    expect(completion).toMatchObject({
      correlationId: "wager-http-test",
      messageId: null,
      transactionId: first.transactionId,
      walletId: wallet.id,
      providerId: input.providerId,
      status: WagerTransactionStatus.Processed,
    });

    expect(completion).not.toHaveProperty("money");
    expect(completion).not.toHaveProperty("balance");

    const failure = events.find(
      (event) =>
        event.event === "http_request_failed" &&
        event.code === "IDEMPOTENCY_CONFLICT",
    );

    expect(failure).toMatchObject({
      correlationId: "wager-http-test",
      walletId: wallet.id,
      providerId: input.providerId,
      statusCode: 409,
    });

    await expectLedgerBalance(wallet.id, "75.00");
  } finally {
    logSpy.mockRestore();
  }
});
