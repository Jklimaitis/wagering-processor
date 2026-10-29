import { expect, test } from "bun:test";
import { Money } from "../../src/domain/money";
import { InvalidIntegrationEventError } from "../../src/domain/integration-event";
import type { EventContext } from "../../src/domain/integration-event";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wager-transaction";
import type { CreateWagerTransactionProps } from "../../src/domain/wager-transaction";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from "../../src/domain/wager-transaction-events";

function context(): EventContext {
  return {
    eventId: "event-1",
    correlationId: "request-1",
    occurredAt: new Date("2026-10-29T12:00:00.000Z"),
  };
}

function transaction(
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create({
    id: "transaction-1",
    providerId: "provider-a",
    externalTransactionId: "external-1",
    idempotencyKey: "provider-a:external-1",
    payloadHash: "test-hash",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: Money.from({
      amount: "25.00",
      currency: "BRL",
    }),
    ...overrides,
  });
}

test("gera evento de processamento inclusive para LOSS", () => {
  const tx = transaction({
    kind: WagerTransactionKind.Loss,
    money: Money.zero("BRL"),
  });

  tx.markProcessed(undefined, context().occurredAt);

  const event = WagerTransactionProcessed.from(tx, context());

  expect(event.toJSON()).toMatchObject({
    eventType: "WagerTransactionProcessed",
    aggregateId: tx.id,
    version: 1,
    data: {
      transactionId: tx.id,
      status: WagerTransactionStatus.Processed,
      kind: WagerTransactionKind.Loss,
      money: { amount: "0.00", currency: "BRL" },
      processedAt: "2026-10-29T12:00:00.000Z",
    },
  });
});

test("evento de rejeição preserva o failureCode", () => {
  const tx = transaction();

  tx.reject(FailureCode.InsufficientBalance);

  const event = WagerTransactionRejected.from(tx, context());

  expect(event.data.status).toBe(WagerTransactionStatus.Rejected);
  expect(event.data.failureCode).toBe(FailureCode.InsufficientBalance);
  expect(event.data.money).toEqual({ amount: "25.00", currency: "BRL" });
});

test("evento pendente preserva a referência e o estado original", () => {
  const tx = transaction({
    kind: WagerTransactionKind.Refund,
    referenceExternalTransactionId: "bet-1",
  });

  tx.markPendingReference();

  const event = WagerTransactionPendingReference.from(tx, context());

  tx.markProcessed("reference-1", context().occurredAt);

  expect(event.data.status).toBe(WagerTransactionStatus.PendingReference);
  expect(event.data.referenceExternalTransactionId).toBe("bet-1");
});

const factories = [
  {
    name: "Processed",
    create: WagerTransactionProcessed.from,
  },
  {
    name: "Rejected",
    create: WagerTransactionRejected.from,
  },
  {
    name: "PendingReference",
    create: WagerTransactionPendingReference.from,
  },
];

test.each(factories)("rejeita transação ainda em PENDING: %j", ({ create }) => {
  expect(() => create(transaction(), context())).toThrow(
    InvalidIntegrationEventError,
  );
});
