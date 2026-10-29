import { expect, test } from "bun:test";
import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";
import { LedgerDirection } from "../../src/domain/wallet-ledger-entry";
import { InvalidIntegrationEventError } from "../../src/domain/integration-event";
import type { EventContext } from "../../src/domain/integration-event";
import { WalletBalanceChanged } from "../../src/domain/wallet-balance-changed";

function context(): EventContext {
  return {
    eventId: "event-1",
    correlationId: "request-1",
    causationId: "message-1",
    occurredAt: new Date("2026-10-29T12:00:00.000Z"),
  };
}

function movement() {
  const wallet = Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: Money.from({
      amount: "100.00",
      currency: "BRL",
    }),
  });

  const entry = wallet.debit({
    entryId: "entry-1",
    transactionId: "transaction-1",
    money: Money.from({
      amount: "25.00",
      currency: "BRL",
    }),
  });

  return { wallet, entry };
}

test("serializa o envelope com dinheiro como strings decimais", () => {
  const { wallet, entry } = movement();

  const event = WalletBalanceChanged.from(wallet, entry, context());

  expect(event.toJSON()).toEqual({
    eventId: "event-1",
    eventType: "WalletBalanceChanged",
    aggregateId: "wallet-1",
    correlationId: "request-1",
    causationId: "message-1",
    occurredAt: "2026-10-29T12:00:00.000Z",
    version: 1,
    data: {
      walletId: "wallet-1",
      transactionId: "transaction-1",
      direction: LedgerDirection.Debit,
      money: { amount: "25.00", currency: "BRL" },
      balanceBefore: { amount: "100.00", currency: "BRL" },
      balanceAfter: { amount: "75.00", currency: "BRL" },
      walletVersion: 2,
    },
  });

  expect(Object.isFrozen(event)).toBe(true);
});

test("alterar os dados retornados não modifica o evento", () => {
  const { wallet, entry } = movement();
  const event = WalletBalanceChanged.from(wallet, entry, context());

  const envelope = event.toJSON();

  envelope.data.money.amount = "999.00";
  envelope.data.balanceAfter.amount = "0.00";

  const data = event.data;
  data.money.amount = "1.00";

  expect(event.data.money.amount).toBe("25.00");
  expect(event.data.balanceAfter.amount).toBe("75.00");
});

test("preserva a data quando objetos externos são alterados", () => {
  const { wallet, entry } = movement();
  const ctx = context();

  const event = WalletBalanceChanged.from(wallet, entry, ctx);

  ctx.occurredAt.setUTCFullYear(2000);
  event.occurredAt.setUTCFullYear(2001);

  expect(event.toJSON().occurredAt).toBe("2026-10-29T12:00:00.000Z");
});

test("rejeita lançamento de outra wallet", () => {
  const { entry } = movement();

  const anotherWallet = Wallet.open({
    id: "wallet-2",
    playerId: "player-2",
    initialBalance: Money.from({
      amount: "75.00",
      currency: "BRL",
    }),
  });

  expect(() =>
    WalletBalanceChanged.from(anotherWallet, entry, context()),
  ).toThrow(InvalidIntegrationEventError);
});

test.each(["eventId", "correlationId", "causationId"] as const)(
  "rejeita identificador vazio: %s",
  (field) => {
    const { wallet, entry } = movement();

    expect(() =>
      WalletBalanceChanged.from(wallet, entry, {
        ...context(),
        [field]: "",
      }),
    ).toThrow(InvalidIntegrationEventError);
  },
);
