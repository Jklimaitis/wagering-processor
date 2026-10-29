import { expect, test } from "bun:test";
import { Money } from "../../src/domain/money";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../../src/domain/wallet-ledger-entry";
import { WalletLedgerEntryMapper } from "../../src/infrastructure/database/wallet-ledger-entry-mapper";

const cases = [
  {
    direction: LedgerDirection.Debit,
    amount: "0.01",
    before: "999999999999999999.99",
    after: "999999999999999999.98",
  },
  {
    direction: LedgerDirection.Credit,
    amount: "999999999999999999.99",
    before: "0.00",
    after: "999999999999999999.99",
  },
];

test.each(cases)(
  "preserva valores exatos e estado do lançamento %j",
  (scenario) => {
    const money = (amount: string): Money =>
      Money.from({ amount, currency: "BRL" });

    const at = new Date("2026-10-29T12:00:00.000Z");

    const entry = WalletLedgerEntry.create({
      id: crypto.randomUUID(),
      walletId: crypto.randomUUID(),
      transactionId: crypto.randomUUID(),
      direction: scenario.direction,
      money: money(scenario.amount),
      balanceBefore: money(scenario.before),
      balanceAfter: money(scenario.after),
      createdAt: at,
    });

    const record = WalletLedgerEntryMapper.toRecord(entry);

    expect(record.amount).toBe(scenario.amount);
    expect(record.balanceBefore).toBe(scenario.before);
    expect(record.balanceAfter).toBe(scenario.after);
    expect(record.currency).toBe("BRL");

    const restored = WalletLedgerEntryMapper.toDomain(record);

    expect(restored.id).toBe(entry.id);
    expect(restored.walletId).toBe(entry.walletId);
    expect(restored.transactionId).toBe(entry.transactionId);
    expect(restored.direction).toBe(scenario.direction);
    expect(restored.money.toString()).toBe(scenario.amount);
    expect(restored.balanceBefore.toString()).toBe(scenario.before);
    expect(restored.balanceAfter.toString()).toBe(scenario.after);
    expect(restored.isBalanced()).toBe(true);
    expect(Object.isFrozen(restored)).toBe(true);

    record.createdAt.setUTCFullYear(2000);

    expect(entry.createdAt).toEqual(at);
    expect(restored.createdAt).toEqual(at);
  },
);
