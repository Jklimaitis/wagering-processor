import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { GetQueueUrlCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { WagerTransactionRecord } from "../../src/infrastructure/database/wager-transaction-record";
import { OutboxMessageRecord } from "../../src/infrastructure/database/outbox-message-record";
import { InboxMessageRecord } from "../../src/infrastructure/database/inbox-message-record";
import { WalletLedgerEntryRecord } from "../../src/infrastructure/database/wallet-ledger-entry-record";
import { createSqsClient, getSqsWagerQueueNames } from "../../src/infrastructure/messaging/sqs-client";
import type { WalletView } from "../../src/infrastructure/database/postgres-wallet-creator";
import type { PostgresWagerResult } from "../../src/infrastructure/database/postgres-wager-processor";
import type { ReconciliationView } from "../../src/infrastructure/database/postgres-financial-reader";

const api = process.env.API_URL ?? "http://127.0.0.1:3000";
const client = createSqsClient();
let orm: MikroORM | undefined;

async function request<T>(path: string, expected: number, body?: unknown, key?: string): Promise<T> {
  const response = await fetch(`${api}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-correlation-id": "compose-verification",
      ...(key === undefined ? {} : { "idempotency-key": key }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, expected, `HTTP inesperado em ${path}`);
  return await response.json() as T;
}

async function eventually<T>(read: () => Promise<T | null>, description: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await delay(100);
  }
  throw new Error(`Timeout: ${description}`);
}

async function main(): Promise<void> {
  await request("/health/ready", 200);
  orm = await MikroORM.init(config);
  await orm.connect();
  const database = orm;
  const wallet = await request<WalletView>("/wallets", 201, {
    playerId: crypto.randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" },
  });
  const operation = (kind: string, amount: string) => ({
    providerId: "compose-verification", externalTransactionId: crypto.randomUUID(),
    walletId: wallet.id, playerId: wallet.playerId, roundId: "round-1", gameId: "game-1",
    kind, money: { amount, currency: "BRL" },
  });
  const bet = operation("BET", "25.00");
  const key = `verify:${crypto.randomUUID()}`;
  const applied = await request<PostgresWagerResult>("/wagering/transactions", 200, bet, key);
  const replay = await request<PostgresWagerResult>("/wagering/transactions", 200, bet, key);
  assert.equal(replay.transactionId, applied.transactionId);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.balance.amount, "75.00");

  const win = operation("WIN", "10.00");
  const messageId = crypto.randomUUID();
  const body = JSON.stringify({ messageId, type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(), correlationId: "compose-verification",
    data: { ...win, idempotencyKey: `verify:${win.externalTransactionId}` },
  });
  const queue = await client.send(new GetQueueUrlCommand({
    QueueName: getSqsWagerQueueNames().queueName,
  }), { abortSignal: AbortSignal.timeout(5_000) });
  assert.ok(queue.QueueUrl);
  for (let delivery = 0; delivery < 2; delivery += 1) {
    await client.send(new SendMessageCommand({
      QueueUrl: queue.QueueUrl, MessageBody: body, MessageGroupId: wallet.id,
      MessageDeduplicationId: crypto.randomUUID(),
    }), { abortSignal: AbortSignal.timeout(5_000) });
  }
  const storedWin = await eventually(async () => {
    const row = await database.em.fork().findOne(WagerTransactionRecord, {
      providerId: win.providerId, externalTransactionId: win.externalTransactionId,
    });
    return row?.status === "PROCESSED" ? row : null;
  }, "WIN via SQS");
  assert.equal(await database.em.fork().count(InboxMessageRecord, { messageId }), 1);
  assert.equal(await database.em.fork().count(WalletLedgerEntryRecord, {
    transactionId: storedWin.id,
  }), 1);

  const futureBet = operation("BET", "5.00");
  const pending = await request<PostgresWagerResult>("/wagering/transactions", 202, {
    ...operation("REFUND", "5.00"), referenceExternalTransactionId: futureBet.externalTransactionId,
  }, `verify:${crypto.randomUUID()}`);
  await request("/wagering/transactions", 200, futureBet, `verify:${crypto.randomUUID()}`);
  await eventually(async () => {
    const row = await request<{ status: string }>(`/wagering/transactions/${pending.transactionId}`, 200);
    return row.status === "PROCESSED" ? row : null;
  }, "worker de referências");

  const report = await request<ReconciliationView>(`/wallets/${wallet.id}/reconciliation`, 200, {});
  assert.equal(report.consistent, true);
  assert.equal(report.storedBalance.amount, "85.00");
  assert.equal(report.difference.amount, "0.00");
  assert.equal(report.checkedEntries, 5);
  const transactions = await database.em.fork().find(WagerTransactionRecord, { walletId: wallet.id });
  assert.equal(transactions.length, 5);
  const filter = { $or: [{ aggregateId: wallet.id }, {
    aggregateId: { $in: transactions.map((transaction) => transaction.id) },
  }] };
  await eventually(async () => {
    const pendingEvents = await database.em.fork().count(OutboxMessageRecord, {
      ...filter, publishedAt: null,
    });
    return pendingEvents === 0 ? true : null;
  }, "publicação da outbox");
  assert.equal(await database.em.fork().count(OutboxMessageRecord, filter), 11);
  console.log(JSON.stringify({ event: "compose_verification_passed",
    walletId: wallet.id, checkedEntries: report.checkedEntries, consistent: true }));
}

try {
  await main();
} catch (error: unknown) {
  console.error(JSON.stringify({ event: "compose_verification_failed",
    errorName: error instanceof Error ? error.name : "UnknownError" }));
  process.exitCode = 1;
} finally {
  try { await orm?.close(true); } finally { client.destroy(); }
}
