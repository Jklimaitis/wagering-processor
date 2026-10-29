import { expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  Money,
} from './money';
import {
  InsufficientBalanceError,
  InvalidWalletError,
  Wallet,
} from './wallet';
import type { WalletMovementProps } from './wallet';
import {
  InvalidLedgerEntryError,
  LedgerDirection,
} from './wallet-ledger-entry';

test('abre carteira com saldo, moeda, versão e datas iniciais', () => {
  const at = new Date('2026-10-28T12:00:00.000Z');

  const wallet = Wallet.open(
    {
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
    },
    at,
  );

  expect(wallet.id).toBe('wallet-1');
  expect(wallet.playerId).toBe('player-1');
  expect(wallet.currency).toBe('BRL');
  expect(wallet.balance.toJSON()).toEqual({
    amount: '100.00',
    currency: 'BRL',
  });
  expect(wallet.version).toBe(1);
  expect(wallet.createdAt).toEqual(at);
  expect(wallet.updatedAt).toEqual(at);
});

test('permite abrir carteira com saldo zero', () => {
  const wallet = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: Money.zero('BRL'),
  });

  expect(wallet.balance.isZero()).toBe(true);
  expect(wallet.version).toBe(1);
});

test('rejeita abertura com saldo negativo', () => {
  const negative = Money.from({
    amount: '1.00',
    currency: 'BRL',
  }).negate();

  expect(() =>
    Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: negative,
    }),
  ).toThrow(InvalidWalletError);
});

test('rejeita abertura sem id da carteira', () => {
  expect(() =>
    Wallet.open({
      id: ' ',
      playerId: 'player-1',
      initialBalance: Money.zero('BRL'),
    }),
  ).toThrow(InvalidWalletError);
});

test('rejeita abertura sem playerId', () => {
  expect(() =>
    Wallet.open({
      id: 'wallet-1',
      playerId: '',
      initialBalance: Money.zero('BRL'),
    }),
  ).toThrow(InvalidWalletError);
});

test('reidrata preservando saldo, versão e datas persistidas', () => {
  const createdAt = new Date('2026-10-27T10:00:00.000Z');
  const updatedAt = new Date('2026-10-28T15:00:00.000Z');

  const wallet = Wallet.rehydrate({
    id: 'wallet-1',
    playerId: 'player-1',
    currency: 'BRL',
    balance: Money.from({
      amount: '75.00',
      currency: 'BRL',
    }),
    version: 8,
    createdAt,
    updatedAt,
  });

  expect(wallet.id).toBe('wallet-1');
  expect(wallet.playerId).toBe('player-1');
  expect(wallet.currency).toBe('BRL');
  expect(wallet.balance.toString()).toBe('75.00');
  expect(wallet.version).toBe(8);
  expect(wallet.createdAt).toEqual(createdAt);
  expect(wallet.updatedAt).toEqual(updatedAt);
});

function createWallet(amount: string = '100.00'): Wallet {
  return Wallet.open(
    {
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({
        amount,
        currency: 'BRL',
      }),
    },
    new Date('2026-10-28T12:00:00.000Z'),
  );
}

function movement(amount: string): WalletMovementProps {
  return {
    entryId: 'entry-1',
    transactionId: 'transaction-1',
    money: Money.from({ amount, currency: 'BRL' }),
  };
}

test('debita e produz o lançamento correspondente', () => {
  const wallet = createWallet();
  const at = new Date('2026-10-28T13:00:00.000Z');

  const entry = wallet.debit(movement('25.00'), at);

  expect(wallet.balance.toString()).toBe('75.00');
  expect(wallet.version).toBe(2);
  expect(wallet.updatedAt).toEqual(at);

  expect(entry.id).toBe('entry-1');
  expect(entry.walletId).toBe(wallet.id);
  expect(entry.transactionId).toBe('transaction-1');
  expect(entry.direction).toBe(LedgerDirection.Debit);
  expect(entry.money.toString()).toBe('25.00');
  expect(entry.balanceBefore.toString()).toBe('100.00');
  expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
  expect(entry.createdAt).toEqual(at);
  expect(entry.isBalanced()).toBe(true);
});

test('credita e produz o lançamento correspondente', () => {
  const wallet = createWallet();
  const at = new Date('2026-10-28T13:00:00.000Z');

  const entry = wallet.credit(movement('25.00'), at);

  expect(wallet.balance.toString()).toBe('125.00');
  expect(wallet.version).toBe(2);
  expect(wallet.updatedAt).toEqual(at);

  expect(entry.direction).toBe(LedgerDirection.Credit);
  expect(entry.balanceBefore.toString()).toBe('100.00');
  expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
  expect(entry.isBalanced()).toBe(true);
});

test('permite zerar o saldo e incrementa a versão a cada movimento', () => {
  const wallet = createWallet();

  const debit = wallet.debit(movement('100.00'));

  expect(wallet.balance.isZero()).toBe(true);
  expect(wallet.version).toBe(2);

  const credit = wallet.credit({
    ...movement('25.00'),
    entryId: 'entry-2',
    transactionId: 'transaction-2',
  });

  expect(wallet.balance.toString()).toBe('25.00');
  expect(wallet.version).toBe(3);
  expect(credit.balanceBefore.equals(debit.balanceAfter)).toBe(true);
});

test('saldo insuficiente preserva todo o estado da carteira', () => {
  const wallet = createWallet();
  const originalDate = wallet.updatedAt;

  expect(() => wallet.debit(movement('100.01')))
    .toThrow(InsufficientBalanceError);

  expect(wallet.balance.toString()).toBe('100.00');
  expect(wallet.version).toBe(1);
  expect(wallet.updatedAt).toEqual(originalDate);
});

test('rejeita moeda diferente, zero e negativo sem alterar a carteira', () => {
  const wallet = createWallet();
  const originalDate = wallet.updatedAt;

  const usd = {
    ...movement('10.00'),
    money: Money.from({ amount: '10.00', currency: 'USD' }),
  };

  expect(() => wallet.debit(usd)).toThrow(CurrencyMismatchError);
  expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);

  const invalidValues = [
    Money.zero('BRL'),
    movement('10.00').money.negate(),
  ];

  for (const money of invalidValues) {
    const props = { ...movement('10.00'), money };

    expect(() => wallet.debit(props)).toThrow(InvalidWalletError);
    expect(() => wallet.credit(props)).toThrow(InvalidWalletError);
  }

  expect(wallet.balance.toString()).toBe('100.00');
  expect(wallet.version).toBe(1);
  expect(wallet.updatedAt).toEqual(originalDate);
});

test('falha ao criar o lançamento preserva a carteira', () => {
  const wallet = createWallet();
  const originalDate = wallet.updatedAt;
  const props = { ...movement('10.00'), entryId: '' };

  expect(() => wallet.debit(props)).toThrow(InvalidLedgerEntryError);
  expect(() => wallet.credit(props)).toThrow(InvalidLedgerEntryError);

  expect(wallet.balance.toString()).toBe('100.00');
  expect(wallet.version).toBe(1);
  expect(wallet.updatedAt).toEqual(originalDate);
});

test('crédito acima do limite monetário preserva a carteira', () => {
  const maximum = '999999999999999999.99';
  const wallet = createWallet(maximum);
  const originalDate = wallet.updatedAt;

  expect(() => wallet.credit(movement('0.01')))
    .toThrow(InvalidMoneyError);

  expect(wallet.balance.toString()).toBe(maximum);
  expect(wallet.version).toBe(1);
  expect(wallet.updatedAt).toEqual(originalDate);
});