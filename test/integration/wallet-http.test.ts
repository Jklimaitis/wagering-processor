import "reflect-metadata";
import { afterAll, beforeAll, expect, test } from "bun:test";
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
import type { PostgresWagerResult } from "../../src/infrastructure/database/postgres-wager-processor";

const schema = `wallet_http_${crypto.randomUUID().replaceAll("-", "")}`;

let orm: MikroORM;
let app: INestApplication | undefined;
let baseUrl = "";

@Module({
  controllers: [WalletsController, WageringController],
  providers: [
    {
      provide: DatabaseService,
      useFactory: () => new DatabaseService({ ...config, schema }),
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
