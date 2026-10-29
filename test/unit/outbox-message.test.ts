import { expect, test } from "bun:test";
import { Money } from "../../src/domain/money";
import {
  WagerTransaction,
  WagerTransactionKind,
} from "../../src/domain/wager-transaction";
import { WagerTransactionProcessed } from "../../src/domain/wager-transaction-events";
import {
  InvalidOutboxStateError,
  OutboxMessage,
} from "../../src/domain/outbox-message";

function eventForTest(): WagerTransactionProcessed {
  const at = new Date("2026-10-29T12:00:00.000Z");

  const transaction = WagerTransaction.create({
    id: "transaction-1",
    providerId: "provider-a",
    externalTransactionId: "external-1",
    idempotencyKey: "provider-a:external-1",
    payloadHash: "test-hash",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Loss,
    money: Money.zero("BRL"),
  });

  transaction.markProcessed(undefined, at);

  return WagerTransactionProcessed.from(transaction, {
    eventId: "event-1",
    correlationId: "request-1",
    occurredAt: at,
  });
}

test("enfileira o envelope preservando a identidade do evento", () => {
  const message = OutboxMessage.enqueue(eventForTest());

  expect(message.id).toBe("event-1");
  expect(message.aggregateId).toBe("transaction-1");
  expect(message.eventType).toBe("WagerTransactionProcessed");
  expect(message.attempts).toBe(0);
  expect(message.isPending()).toBe(true);
  expect(message.nextAttemptAt).toBeUndefined();
  expect(message.publishedAt).toBeUndefined();

  expect(message.isDue(new Date("2026-10-29T12:00:00.000Z"))).toBe(true);

  expect(message.payload).toMatchObject({
    eventId: "event-1",
    eventType: "WagerTransactionProcessed",
    correlationId: "request-1",
    version: 1,
    data: {
      money: { amount: "0.00", currency: "BRL" },
    },
  });

  expect("causationId" in message.payload).toBe(false);
});

test("agenda retries com backoff exponencial", () => {
  const message = OutboxMessage.enqueue(eventForTest());
  const now = new Date("2026-10-29T12:00:00.000Z");

  message.scheduleRetry(now);

  expect(message.attempts).toBe(1);
  expect(message.nextAttemptAt).toEqual(new Date("2026-10-29T12:00:01.000Z"));

  expect(message.isDue(new Date("2026-10-29T12:00:00.999Z"))).toBe(false);

  expect(message.isDue(new Date("2026-10-29T12:00:01.000Z"))).toBe(true);

  message.scheduleRetry(new Date("2026-10-29T12:00:01.000Z"));

  expect(message.attempts).toBe(2);
  expect(message.nextAttemptAt).toEqual(new Date("2026-10-29T12:00:03.000Z"));
});

test("limita o intervalo entre retries a cinco minutos", () => {
  const message = OutboxMessage.enqueue(eventForTest());
  const now = new Date("2026-10-29T12:00:00.000Z");

  for (let index = 0; index < 20; index += 1) {
    message.scheduleRetry(now);
  }

  expect(message.attempts).toBe(20);
  expect(message.nextAttemptAt).toEqual(new Date("2026-10-29T12:05:00.000Z"));
});

test("publicação encerra o agendamento e bloqueia transições", () => {
  const message = OutboxMessage.enqueue(eventForTest());
  const at = new Date("2026-10-29T12:00:10.000Z");

  message.scheduleRetry(new Date("2026-10-29T12:00:00.000Z"));

  message.markPublished(at);

  expect(message.isPending()).toBe(false);
  expect(message.isDue(at)).toBe(false);
  expect(message.publishedAt).toEqual(at);
  expect(message.nextAttemptAt).toBeUndefined();
  expect(message.attempts).toBe(1);

  expect(() => message.scheduleRetry(at)).toThrow(InvalidOutboxStateError);

  expect(() => message.markPublished(at)).toThrow(InvalidOutboxStateError);
});

test("reidrata preservando estado e isolando objetos externos", () => {
  const event = eventForTest();
  const payload = event.toJSON();
  const occurredAt = event.occurredAt;
  const nextAttemptAt = new Date("2026-10-29T12:05:00.000Z");

  const message = OutboxMessage.rehydrate({
    id: event.eventId,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    payload,
    occurredAt,
    attempts: 7,
    nextAttemptAt,
  });

  payload.data.money.amount = "999.00";
  occurredAt.setUTCFullYear(2000);
  nextAttemptAt.setUTCFullYear(2000);
  message.nextAttemptAt?.setUTCFullYear(2001);

  expect(message.attempts).toBe(7);
  expect(message.occurredAt).toEqual(new Date("2026-10-29T12:00:00.000Z"));
  expect(message.nextAttemptAt).toEqual(new Date("2026-10-29T12:05:00.000Z"));

  expect(message.payload).toMatchObject({
    data: {
      money: { amount: "0.00", currency: "BRL" },
    },
  });
});
