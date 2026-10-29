import { expect, test } from "bun:test";
import { InvalidInputError } from "../../src/application/input-validation";
import { parseWagerMessage } from "../../src/application/parse-wager-message";
import { hashWagerPayload } from "../../src/infrastructure/idempotency/wager-payload-hash";

function envelope() {
  return {
    messageId: "msg-123",
    type: "WagerTransactionRequested",
    occurredAt: "2026-07-29T15:00:00.000Z",
    data: {
      providerId: "provider-a",
      externalTransactionId: "transaction-123",
      idempotencyKey: "provider-a:transaction-123",
      playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
      walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
      roundId: "round-987",
      gameId: "fortune-chimp",
      kind: "BET",
      money: {
        amount: "25.00",
        currency: "BRL",
      },
    },
  };
}

function encode(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...envelope(),
    ...patch,
  });
}

test("interpreta o contrato e usa messageId como correlationId padrão", () => {
  const parsed = parseWagerMessage(encode());

  expect(parsed.messageId).toBe("msg-123");
  expect(parsed.type).toBe("WagerTransactionRequested");
  expect(parsed.correlationId).toBe("msg-123");
  expect(parsed.occurredAt.toISOString()).toBe("2026-07-29T15:00:00.000Z");
  expect(parsed.data.idempotencyKey).toBe("provider-a:transaction-123");
  expect(parsed.data.money.toJSON()).toEqual({
    amount: "25.00",
    currency: "BRL",
  });
});

test("preserva correlationId informado pelo produtor", () => {
  const parsed = parseWagerMessage(
    encode({ correlationId: "correlation-original" }),
  );

  expect(parsed.correlationId).toBe("correlation-original");
});

test("aceita timestamp UTC sem milissegundos", () => {
  const parsed = parseWagerMessage(
    encode({ occurredAt: "2026-07-29T15:00:00Z" }),
  );

  expect(parsed.occurredAt.toISOString()).toBe("2026-07-29T15:00:00.000Z");
});

test("metadados do envelope não alteram o hash financeiro", () => {
  const first = parseWagerMessage(encode());

  const second = parseWagerMessage(
    encode({
      messageId: "msg-456",
      correlationId: "outra-correlacao",
      occurredAt: "2026-07-30T15:00:00.000Z",
    }),
  );

  expect(hashWagerPayload(second.data)).toBe(hashWagerPayload(first.data));
});

const invalidBodies: Array<[string, string | undefined]> = [
  ["corpo ausente", undefined],
  ["corpo vazio", ""],
  ["JSON incompleto", "{"],
  ["JSON nulo", "null"],
  ["JSON como array", "[]"],
  ["tipo incorreto", encode({ type: "WalletBalanceChanged" })],
  ["messageId ausente", encode({ messageId: undefined })],
  ["messageId vazio", encode({ messageId: "   " })],
  ["data de ocorrência ausente", encode({ occurredAt: undefined })],
  ["data inválida", encode({ occurredAt: "ontem" })],
  ["dia inexistente", encode({ occurredAt: "2026-02-30T15:00:00.000Z" })],
  ["data da aposta nula", encode({ data: null })],
  [
    "chave de idempotência ausente",
    encode({
      data: {
        ...envelope().data,
        idempotencyKey: undefined,
      },
    }),
  ],
  [
    "dinheiro numérico",
    encode({
      data: {
        ...envelope().data,
        money: { amount: 25, currency: "BRL" },
      },
    }),
  ],
  ["correlationId vazio", encode({ correlationId: "" })],
  ["correlationId nulo", encode({ correlationId: null })],
  [
    "OPENING externo",
    encode({
      data: {
        ...envelope().data,
        kind: "OPENING",
      },
    }),
  ],
];

test.each(invalidBodies)("rejeita %s", (_name, body) => {
  expect(() => parseWagerMessage(body)).toThrow(InvalidInputError);
});
