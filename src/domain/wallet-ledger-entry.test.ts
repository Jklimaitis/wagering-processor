import { expect, test } from 'bun:test';
import { Money } from './money';
import {
  InvalidLedgerEntryError,
  LedgerDirection,
  WalletLedgerEntry,
} from './wallet-ledger-entry';
import type { LedgerEntryState } from './wallet-ledger-entry';

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function entryProps(
  overrides: Partial<LedgerEntryState> = {},
): LedgerEntryState {
  return {
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'transaction-1',
    direction: LedgerDirection.Credit,
    money: brl('25.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('125.00'),
    createdAt: new Date('2026-10-28T12:00:00.000Z'),
    ...overrides,
  };
}

test('cria um lançamento de crédito consistente', () => {
  const entry = WalletLedgerEntry.create(entryProps());

  expect(entry.direction).toBe(LedgerDirection.Credit);
  expect(entry.balanceAfter.toString()).toBe('125.00');
  expect(entry.isBalanced()).toBe(true);
  expect(Object.isFrozen(entry)).toBe(true);
});

test('cria um lançamento de débito consistente', () => {
  const entry = WalletLedgerEntry.create(entryProps({
    direction: LedgerDirection.Debit,
    balanceAfter: brl('75.00'),
  }));

  expect(entry.direction).toBe(LedgerDirection.Debit);
  expect(entry.isBalanced()).toBe(true);
});

test('rejeita lançamento cuja conta não fecha', () => {
  expect(() =>
    WalletLedgerEntry.create(entryProps({
      balanceAfter: brl('124.00'),
    })),
  ).toThrow(InvalidLedgerEntryError);
});

test('rejeita valor zero ou negativo', () => {
  const invalidValues = [
    Money.zero('BRL'),
    brl('25.00').negate(),
  ];

  for (const money of invalidValues) {
    expect(() =>
      WalletLedgerEntry.create(entryProps({ money })),
    ).toThrow(InvalidLedgerEntryError);
  }
});

test('rejeita saldo anterior ou posterior negativo', () => {
  const negative = brl('1.00').negate();

  expect(() =>
    WalletLedgerEntry.create(entryProps({
      balanceBefore: negative,
    })),
  ).toThrow(InvalidLedgerEntryError);

  expect(() =>
    WalletLedgerEntry.create(entryProps({
      balanceAfter: negative,
    })),
  ).toThrow(InvalidLedgerEntryError);
});

test('rejeita moedas diferentes no lançamento', () => {
  expect(() =>
    WalletLedgerEntry.create(entryProps({
      money: Money.from({
        amount: '25.00',
        currency: 'USD',
      }),
    })),
  ).toThrow(InvalidLedgerEntryError);
});

test('rejeita identificadores vazios', () => {
  const invalidProps = [
    entryProps({ id: '' }),
    entryProps({ walletId: ' ' }),
    entryProps({ transactionId: '' }),
  ];

  for (const props of invalidProps) {
    expect(() => WalletLedgerEntry.create(props))
      .toThrow(InvalidLedgerEntryError);
  }
});

test('reidrata preservando os dados persistidos', () => {
  const state = entryProps();
  const entry = WalletLedgerEntry.rehydrate(state);

  expect(entry.id).toBe(state.id);
  expect(entry.walletId).toBe(state.walletId);
  expect(entry.transactionId).toBe(state.transactionId);
  expect(entry.direction).toBe(state.direction);
  expect(entry.money.equals(state.money)).toBe(true);
  expect(entry.balanceBefore.equals(state.balanceBefore)).toBe(true);
  expect(entry.balanceAfter.equals(state.balanceAfter)).toBe(true);
  expect(entry.createdAt).toEqual(state.createdAt);
});

test('preserva a data quando objetos Date externos são alterados', () => {
  const state = entryProps();
  const originalTime = state.createdAt.getTime();
  const entry = WalletLedgerEntry.create(state);

  state.createdAt.setTime(0);

  const returnedDate = entry.createdAt;
  returnedDate.setTime(0);

  expect(entry.createdAt.getTime()).toBe(originalTime);
});