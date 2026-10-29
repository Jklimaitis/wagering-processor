import { expect, test } from "bun:test";
import { Money } from "../../src/domain/money";
import { WagerTransactionKind } from "../../src/domain/wager-transaction";
import type { CreateWagerTransactionProps } from "../../src/domain/wager-transaction";
import { hashWagerPayload } from "../../src/infrastructure/idempotency/wager-payload-hash";
import type { WagerBusinessPayload } from "../../src/infrastructure/idempotency/wager-payload-hash";

function payload(): CreateWagerTransactionProps {
  return {
    id: "internal-1",
    providerId: "provider-a",
    externalTransactionId: "external-1",
    idempotencyKey: "provider-a:external-1",
    payloadHash: "hash-anterior",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: Money.from({
      amount: "25.00",
      currency: "BRL",
    }),
  };
}

test("gera SHA-256 hexadecimal com 64 caracteres", () => {
  expect(hashWagerPayload(payload())).toMatch(/^[0-9a-f]{64}$/);
});

test("a ordem das propriedades recebidas não altera o hash", () => {
  const original = payload();

  const reordered: WagerBusinessPayload = {
    walletId: original.walletId,
    roundId: original.roundId,
    providerId: original.providerId,
    playerId: original.playerId,
    money: original.money,
    kind: original.kind,
    gameId: original.gameId,
    externalTransactionId: original.externalTransactionId,
  };

  expect(hashWagerPayload(reordered)).toBe(hashWagerPayload(original));
});

test("ignora ID interno, chave, hash anterior e transporte", () => {
  const original = payload();

  const retry = {
    ...original,
    id: "internal-2",
    idempotencyKey: "outra-chave",
    payloadHash: "outro-hash-anterior",
    messageId: "message-2",
    correlationId: "correlation-2",
  };

  expect(hashWagerPayload(retry)).toBe(hashWagerPayload(original));
});

test("referência ausente e undefined geram o mesmo hash", () => {
  const original = payload();

  expect(
    hashWagerPayload({
      ...original,
      referenceExternalTransactionId: undefined,
    }),
  ).toBe(hashWagerPayload(original));
});

const changes: Array<{
  field: string;
  patch: Partial<WagerBusinessPayload>;
}> = [
  {
    field: "providerId",
    patch: { providerId: "provider-b" },
  },
  {
    field: "externalTransactionId",
    patch: { externalTransactionId: "external-2" },
  },
  {
    field: "walletId",
    patch: { walletId: "wallet-2" },
  },
  {
    field: "playerId",
    patch: { playerId: "player-2" },
  },
  {
    field: "roundId",
    patch: { roundId: "round-2" },
  },
  {
    field: "gameId",
    patch: { gameId: "game-2" },
  },
  {
    field: "kind",
    patch: { kind: WagerTransactionKind.Win },
  },
  {
    field: "money.amount",
    patch: {
      money: Money.from({
        amount: "26.00",
        currency: "BRL",
      }),
    },
  },
  {
    field: "money.currency",
    patch: {
      money: Money.from({
        amount: "25.00",
        currency: "USD",
      }),
    },
  },
  {
    field: "referenceExternalTransactionId",
    patch: { referenceExternalTransactionId: "original-1" },
  },
];

test.each(changes)("mudança de negócio altera o hash: %j", ({ patch }) => {
  const original = payload();

  expect(
    hashWagerPayload({
      ...original,
      ...patch,
    }),
  ).not.toBe(hashWagerPayload(original));
});
