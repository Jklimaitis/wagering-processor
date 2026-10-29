import { expect, test } from "bun:test";
import { InvalidInputError } from "../../src/application/input-validation";
import { parseWagerRequest } from "../../src/application/parse-wager-request";
import { WagerTransactionKind } from "../../src/domain/wager-transaction";

const key = "provider-a:transaction-123";

function validBody() {
  return {
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: {
      amount: "25.00",
      currency: "BRL",
    },
  };
}

test("converte dinheiro sem perder precisão nem alterar a entrada", () => {
  const body = validBody();
  body.money.amount = "999999999999999999.99";

  const original = structuredClone(body);
  const parsed = parseWagerRequest(body, key);

  expect(parsed.money.toJSON()).toEqual(body.money);
  expect(parsed.kind).toBe(WagerTransactionKind.Bet);
  expect(body).toEqual(original);
});

test("usa a chave fornecida separadamente e ignora campos internos", () => {
  const parsed = parseWagerRequest(
    {
      ...validBody(),
      idempotencyKey: "chave-do-corpo",
      id: "id-enviado-pelo-cliente",
      payloadHash: "hash-enviado-pelo-cliente",
    },
    key,
  );

  expect(parsed.idempotencyKey).toBe(key);
  expect(parsed).not.toHaveProperty("id");
  expect(parsed).not.toHaveProperty("payloadHash");
});

test("normaliza a caixa dos UUIDs", () => {
  const body = validBody();

  const parsed = parseWagerRequest(
    {
      ...body,
      walletId: body.walletId.toUpperCase(),
      playerId: body.playerId.toUpperCase(),
    },
    key,
  );

  expect(parsed.walletId).toBe(body.walletId);
  expect(parsed.playerId).toBe(body.playerId);
});

test("preserva a referência externa de um REFUND", () => {
  const parsed = parseWagerRequest(
    {
      ...validBody(),
      kind: "REFUND",
      referenceExternalTransactionId: "bet-original",
    },
    key,
  );

  expect(parsed.kind).toBe(WagerTransactionKind.Refund);
  expect(parsed.referenceExternalTransactionId).toBe("bet-original");
});

test("aceita LOSS com valor zero", () => {
  const parsed = parseWagerRequest(
    {
      ...validBody(),
      kind: "LOSS",
      money: { amount: "0.00", currency: "BRL" },
    },
    key,
  );

  expect(parsed.kind).toBe(WagerTransactionKind.Loss);
  expect(parsed.money.toString()).toBe("0.00");
});

const invalidInputs: Array<[string, unknown]> = [
  ["corpo nulo", null],
  ["corpo como array", []],
  ["provider vazio", { ...validBody(), providerId: "   " }],
  ["wallet inválida", { ...validBody(), walletId: "wallet-1" }],
  ["player numérico", { ...validBody(), playerId: 123 }],
  ["OPENING externo", { ...validBody(), kind: "OPENING" }],
  ["tipo desconhecido", { ...validBody(), kind: "CREDIT" }],
  ["money nulo", { ...validBody(), money: null }],
  [
    "valor numérico",
    { ...validBody(), money: { amount: 25, currency: "BRL" } },
  ],
  [
    "valor negativo",
    { ...validBody(), money: { amount: "-25.00", currency: "BRL" } },
  ],
  [
    "escala inválida",
    { ...validBody(), money: { amount: "25.001", currency: "BRL" } },
  ],
  [
    "moeda não suportada",
    { ...validBody(), money: { amount: "25.00", currency: "XYZ" } },
  ],
  ["referência nula", { ...validBody(), referenceExternalTransactionId: null }],
];

test.each(invalidInputs)("rejeita %s", (_name, input) => {
  expect(() => parseWagerRequest(input, key)).toThrow(InvalidInputError);
});

test.each([undefined, "", "   ", 123])(
  "rejeita chave inválida: %j",
  (invalidKey) => {
    expect(() => parseWagerRequest(validBody(), invalidKey)).toThrow(
      InvalidInputError,
    );
  },
);
