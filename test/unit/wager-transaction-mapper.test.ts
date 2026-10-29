import { expect, test } from "bun:test";
import { Money } from "../../src/domain/money";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wager-transaction";
import { WagerTransactionMapper } from "../../src/infrastructure/database/wager-transaction-mapper";

function createTransaction(): WagerTransaction {
  return WagerTransaction.create(
    {
      id: crypto.randomUUID(),
      providerId: "provider-a",
      externalTransactionId: "refund-1",
      idempotencyKey: "provider-a:refund-1",
      payloadHash: "hash-do-payload",
      walletId: crypto.randomUUID(),
      playerId: crypto.randomUUID(),
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Refund,
      money: Money.from({
        amount: "999999999999999999.99",
        currency: "BRL",
      }),
      referenceExternalTransactionId: "bet-1",
    },
    new Date("2026-10-29T12:00:00.000Z"),
  );
}

test("preserva valor exato, referências e processamento", () => {
  const transaction = createTransaction();
  const referenceId = crypto.randomUUID();
  const at = new Date("2026-10-29T12:01:00.000Z");

  transaction.markProcessed(referenceId, at);

  const record = WagerTransactionMapper.toRecord(transaction);

  expect(record.amount).toBe("999999999999999999.99");
  expect(typeof record.amount).toBe("string");
  expect(record.referenceExternalTransactionId).toBe("bet-1");
  expect(record.referenceTransactionId).toBe(referenceId);
  expect(record.failureCode).toBeNull();

  const restored = WagerTransactionMapper.toDomain(record);

  expect(restored.id).toBe(transaction.id);
  expect(restored.status).toBe(WagerTransactionStatus.Processed);
  expect(restored.money.equals(transaction.money)).toBe(true);
  expect(restored.referenceTransactionId).toBe(referenceId);
  expect(restored.processedAt).toEqual(at);
  expect(restored.createdAt).toEqual(transaction.createdAt);

  record.createdAt.setUTCFullYear(2000);
  record.processedAt!.setUTCFullYear(2000);

  expect(restored.createdAt.getUTCFullYear()).toBe(2026);
  expect(restored.processedAt?.getUTCFullYear()).toBe(2026);
});

test("converte ausências e preserva a rejeição auditável", () => {
  const transaction = createTransaction();

  const pending = WagerTransactionMapper.toRecord(transaction);

  expect(pending.referenceTransactionId).toBeNull();
  expect(pending.failureCode).toBeNull();
  expect(pending.processedAt).toBeNull();

  transaction.reject(FailureCode.InvalidReference);

  const record = WagerTransactionMapper.toRecord(transaction);
  const restored = WagerTransactionMapper.toDomain(record);

  expect(restored.status).toBe(WagerTransactionStatus.Rejected);
  expect(restored.failureCode).toBe(FailureCode.InvalidReference);
  expect(restored.referenceTransactionId).toBeUndefined();
  expect(restored.processedAt).toBeUndefined();
});

test('guarda o saldo observado com sua própria moeda', () => {
  const transaction = createTransaction();

  transaction.reject(FailureCode.CurrencyMismatch);

  const observedBalance = Money.from({
    amount: '75.00',
    currency: 'USD',
  });

  const record = WagerTransactionMapper.toRecord(
    transaction,
    observedBalance,
  );

  expect(record.currency).toBe('BRL');
  expect(record.resultBalance).toBe('75.00');
  expect(record.resultCurrency).toBe('USD');
  expect(observedBalance.toString()).toBe('75.00');
});