import { expect, test } from 'bun:test';
import { Money } from './money';
import { Wallet } from './wallet';
import { LedgerDirection } from './wallet-ledger-entry';
import {
  FailureCode,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';
import type {
  CreateWagerTransactionProps,
} from './wager-transaction';
import { WagerProcessor } from './wager-processor';
import type { ProcessWagerInput } from './wager-processor';

const processor = new WagerProcessor();

function context(
  overrides: Partial<CreateWagerTransactionProps> = {},
  balance: string = '100.00',
): ProcessWagerInput {
  return {
    transaction: WagerTransaction.create({
      id: 'transaction-1',
      providerId: 'provider-1',
      externalTransactionId: 'external-1',
      idempotencyKey: 'provider-1:external-1',
      payloadHash: 'hash-do-payload',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      ...overrides,
    }),
    wallet: Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({
        amount: balance,
        currency: 'BRL',
      }),
    }),
    entryId: 'entry-1',
    reversalAlreadyProcessed: false,
  };
}

function processedReference(
  kind: WagerTransactionKind = WagerTransactionKind.Bet,
): WagerTransaction {
  const needsReference = kind === WagerTransactionKind.Refund;

  const transaction = context({
    id: 'original-id',
    externalTransactionId: 'original-1',
    idempotencyKey: 'provider-1:original-1',
    kind,
    referenceExternalTransactionId:
      needsReference ? 'older-1' : undefined,
  }).transaction;

  transaction.markProcessed(
    needsReference ? 'older-internal-id' : undefined,
  );

  return transaction;
}

const financialCases = [
  {
    kind: WagerTransactionKind.Bet,
    referenceKind: undefined,
    balance: '75.00',
    direction: LedgerDirection.Debit,
  },
  {
    kind: WagerTransactionKind.Win,
    referenceKind: undefined,
    balance: '125.00',
    direction: LedgerDirection.Credit,
  },
  {
    kind: WagerTransactionKind.Refund,
    referenceKind: WagerTransactionKind.Bet,
    balance: '125.00',
    direction: LedgerDirection.Credit,
  },
  {
    kind: WagerTransactionKind.Rollback,
    referenceKind: WagerTransactionKind.Bet,
    balance: '125.00',
    direction: LedgerDirection.Credit,
  },
  {
    kind: WagerTransactionKind.Rollback,
    referenceKind: WagerTransactionKind.Win,
    balance: '75.00',
    direction: LedgerDirection.Debit,
  },
  {
    kind: WagerTransactionKind.Rollback,
    referenceKind: WagerTransactionKind.Refund,
    balance: '75.00',
    direction: LedgerDirection.Debit,
  },
];

test.each(financialCases)(
  'processa caso financeiro %j',
  (scenario) => {
    const input = context({
      kind: scenario.kind,
      referenceExternalTransactionId:
        scenario.referenceKind === undefined
          ? undefined
          : 'original-1',
    });

    if (scenario.referenceKind !== undefined) {
      input.reference = processedReference(scenario.referenceKind);
    }

    const entry = processor.process(input);

    expect(input.transaction.status)
      .toBe(WagerTransactionStatus.Processed);
    expect(input.wallet.balance.toString()).toBe(scenario.balance);
    expect(input.wallet.version).toBe(2);
    expect(entry?.direction).toBe(scenario.direction);
    expect(entry?.transactionId).toBe(input.transaction.id);
    expect(entry?.balanceAfter.equals(input.wallet.balance)).toBe(true);
    expect(input.transaction.referenceTransactionId)
      .toBe(input.reference?.id);
  },
);

test('processa LOSS sem ledger nem mudança de saldo ou versão', () => {
  const input = context({
    kind: WagerTransactionKind.Loss,
    money: Money.zero('BRL'),
  });
  const originalDate = input.wallet.updatedAt;

  const entry = processor.process(input);

  expect(entry).toBeUndefined();
  expect(input.transaction.status)
    .toBe(WagerTransactionStatus.Processed);
  expect(input.wallet.balance.toString()).toBe('100.00');
  expect(input.wallet.version).toBe(1);
  expect(input.wallet.updatedAt).toEqual(originalDate);
});

test('distingue saldo insuficiente de aposta e de reversão', () => {
  const bet = context({}, '10.00');

  expect(processor.process(bet)).toBeUndefined();
  expect(bet.transaction.status)
    .toBe(WagerTransactionStatus.Rejected);
  expect(bet.transaction.failureCode)
    .toBe(FailureCode.InsufficientBalance);

  const rollback = context({
    kind: WagerTransactionKind.Rollback,
    referenceExternalTransactionId: 'original-1',
  }, '10.00');

  rollback.reference = processedReference(WagerTransactionKind.Win);

  expect(processor.process(rollback)).toBeUndefined();
  expect(rollback.transaction.status)
    .toBe(WagerTransactionStatus.Rejected);
  expect(rollback.transaction.failureCode)
    .toBe(FailureCode.InsufficientBalanceForReversal);

  expect(bet.wallet.balance.toString()).toBe('10.00');
  expect(rollback.wallet.balance.toString()).toBe('10.00');
  expect(bet.wallet.version).toBe(1);
  expect(rollback.wallet.version).toBe(1);
});

test('aguarda referência e processa quando ela fica disponível', () => {
  const input = context({
    kind: WagerTransactionKind.Refund,
    referenceExternalTransactionId: 'original-1',
  });

  expect(processor.process(input)).toBeUndefined();
  expect(input.transaction.status)
    .toBe(WagerTransactionStatus.PendingReference);

  expect(processor.process(input)).toBeUndefined();
  expect(input.wallet.balance.toString()).toBe('100.00');
  expect(input.wallet.version).toBe(1);

  input.reference = processedReference();

  const entry = processor.process(input);

  expect(entry?.direction).toBe(LedgerDirection.Credit);
  expect(input.transaction.status)
    .toBe(WagerTransactionStatus.Processed);
  expect(input.wallet.balance.toString()).toBe('125.00');
  expect(input.wallet.version).toBe(2);
});

test('rejeita referência inválida sem movimentar a carteira', () => {
  const input = context({
    kind: WagerTransactionKind.Refund,
    referenceExternalTransactionId: 'original-1',
  });

  input.reference = processedReference(WagerTransactionKind.Win);

  expect(processor.process(input)).toBeUndefined();
  expect(input.transaction.failureCode)
    .toBe(FailureCode.InvalidReference);
  expect(input.wallet.balance.toString()).toBe('100.00');
  expect(input.wallet.version).toBe(1);
});

test('rejeita uma reversão já aplicada pelo mesmo tipo', () => {
  const input = context({
    kind: WagerTransactionKind.Refund,
    referenceExternalTransactionId: 'original-1',
  });

  input.reference = processedReference();
  input.reversalAlreadyProcessed = true;

  expect(processor.process(input)).toBeUndefined();
  expect(input.transaction.failureCode)
    .toBe(FailureCode.AlreadyReversed);
  expect(input.wallet.balance.toString()).toBe('100.00');
  expect(input.wallet.version).toBe(1);
});

test('valida carteira, jogador e moeda mesmo em LOSS', () => {
  const cases = [
    {
      changes: { walletId: 'other-wallet' },
      code: FailureCode.WalletMismatch,
    },
    {
      changes: { playerId: 'other-player' },
      code: FailureCode.PlayerMismatch,
    },
    {
      changes: {
        money: Money.from({ amount: '25.00', currency: 'USD' }),
      },
      code: FailureCode.CurrencyMismatch,
    },
  ];

  for (const item of cases) {
    const input = context({
      kind: WagerTransactionKind.Loss,
      ...item.changes,
    });

    expect(processor.process(input)).toBeUndefined();
    expect(input.transaction.status)
      .toBe(WagerTransactionStatus.Rejected);
    expect(input.transaction.failureCode).toBe(item.code);
    expect(input.wallet.balance.toString()).toBe('100.00');
    expect(input.wallet.version).toBe(1);
  }
});

test('impede reaplicar uma transação terminal', () => {
  const input = context();

  processor.process(input);

  expect(() => processor.process(input))
    .toThrow(InvalidTransactionStateError);

  expect(input.wallet.balance.toString()).toBe('75.00');
  expect(input.wallet.version).toBe(2);
});

test('rejeita crédito que ultrapassa o limite monetário', () => {
  const maximum = '999999999999999999.99';

  const input = context({
    kind: WagerTransactionKind.Win,
  }, maximum);

  expect(processor.process(input)).toBeUndefined();
  expect(input.transaction.failureCode)
    .toBe(FailureCode.MonetaryLimitExceeded);
  expect(input.wallet.balance.toString()).toBe(maximum);
  expect(input.wallet.version).toBe(1);
});

test('impede aplicar OPENING novamente sobre a carteira aberta', () => {
  const input = context({
    kind: WagerTransactionKind.Opening,
  });

  expect(() => processor.process(input))
    .toThrow(InvalidWagerTransactionError);

  expect(input.wallet.balance.toString()).toBe('100.00');
  expect(input.wallet.version).toBe(1);
});