import "reflect-metadata";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Module, type INestApplication } from "@nestjs/common";
import { APP_FILTER, NestFactory } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import {
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

const schema = `wallet_http_${crypto.randomUUID().replaceAll("-", "")}`;

let orm: MikroORM;
let app: INestApplication | undefined;
let baseUrl = "";

@Module({
  controllers: [WalletsController],
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
