import { expect, test } from 'bun:test';
import { Money } from './money';
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

function transactionProps(
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps {
  return {
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
  };
}

test.each(Object.values(WagerTransactionKind))(
  'cria %s em PENDING com comportamento correspondente',
  (kind) => {
    const requiresReference =
      kind === WagerTransactionKind.Refund ||
      kind === WagerTransactionKind.Rollback;

    const transaction = WagerTransaction.create(transactionProps({
      kind,
      referenceExternalTransactionId:
        requiresReference ? 'original-1' : undefined,
    }));

    expect(transaction.kind).toBe(kind);
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.requiresReference()).toBe(requiresReference);
    expect(transaction.affectsBalance())
      .toBe(kind !== WagerTransactionKind.Loss);
  },
);

test.each([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
])('rejeita %s sem referência', (kind) => {
  expect(() =>
    WagerTransaction.create(transactionProps({ kind })),
  ).toThrow(InvalidWagerTransactionError);
});

test('LOSS aceita valor zero sem movimentar saldo', () => {
  const transaction = WagerTransaction.create(transactionProps({
    kind: WagerTransactionKind.Loss,
    money: Money.zero('BRL'),
  }));

  expect(transaction.affectsBalance()).toBe(false);
  expect(transaction.money.isZero()).toBe(true);
});

test('rejeita valor zero em operações que movimentam saldo', () => {
  const financialKinds = Object.values(WagerTransactionKind)
    .filter((kind) => kind !== WagerTransactionKind.Loss);

  for (const kind of financialKinds) {
    expect(() =>
      WagerTransaction.create(transactionProps({
        kind,
        money: Money.zero('BRL'),
        referenceExternalTransactionId: 'original-1',
      })),
    ).toThrow(InvalidWagerTransactionError);
  }
});

test('rejeita valor negativo inclusive para LOSS', () => {
  expect(() =>
    WagerTransaction.create(transactionProps({
      kind: WagerTransactionKind.Loss,
      money: Money.from({
        amount: '1.00',
        currency: 'BRL',
      }).negate(),
    })),
  ).toThrow(InvalidWagerTransactionError);
});

test('rejeita identificação vazia do provedor', () => {
  expect(() =>
    WagerTransaction.create(transactionProps({
      providerId: ' ',
    })),
  ).toThrow(InvalidWagerTransactionError);
});

test('rejeita referência informada como texto vazio', () => {
  expect(() =>
    WagerTransaction.create(transactionProps({
      referenceExternalTransactionId: ' ',
    })),
  ).toThrow(InvalidWagerTransactionError);
});

test('identifica hashes iguais e diferentes', () => {
  const transaction = WagerTransaction.create(transactionProps());

  expect(transaction.matchesPayload('hash-do-payload')).toBe(true);
  expect(transaction.matchesPayload('outro-hash')).toBe(false);
});

test('reidrata preservando identidade, status e data', () => {
  const props = transactionProps();
  const createdAt = new Date('2026-10-28T12:00:00.000Z');

  const transaction = WagerTransaction.rehydrate({
    ...props,
    status: WagerTransactionStatus.Processed,
    createdAt,
  });

  expect(transaction.id).toBe(props.id);
  expect(transaction.externalTransactionId)
    .toBe(props.externalTransactionId);
  expect(transaction.status).toBe(WagerTransactionStatus.Processed);
  expect(transaction.createdAt).toEqual(createdAt);
  expect(transaction.isTerminal()).toBe(true);
});


function referencedTransaction(): WagerTransaction {
  return WagerTransaction.create(transactionProps({
    kind: WagerTransactionKind.Refund,
    referenceExternalTransactionId: 'original-1',
  }));
}

test('processa operação sem referência e registra a data', () => {
  const transaction = WagerTransaction.create(transactionProps());
  const at = new Date('2026-10-28T13:00:00.000Z');

  transaction.markProcessed(undefined, at);

  expect(transaction.status).toBe(WagerTransactionStatus.Processed);
  expect(transaction.processedAt).toEqual(at);
  expect(transaction.referenceTransactionId).toBeUndefined();
  expect(transaction.failureCode).toBeUndefined();
});

test('aguarda referência e depois processa com o id interno', () => {
  const transaction = referencedTransaction();

  transaction.markPendingReference();

  expect(transaction.status)
    .toBe(WagerTransactionStatus.PendingReference);
  expect(transaction.isTerminal()).toBe(false);

  transaction.markProcessed('internal-original-1');

  expect(transaction.status).toBe(WagerTransactionStatus.Processed);
  expect(transaction.referenceTransactionId)
    .toBe('internal-original-1');
});

test('não processa referência externa sem resolver o id interno', () => {
  const transaction = referencedTransaction();

  expect(() => transaction.markProcessed(undefined))
    .toThrow(InvalidWagerTransactionError);

  expect(transaction.status).toBe(WagerTransactionStatus.Pending);
  expect(transaction.referenceTransactionId).toBeUndefined();
  expect(transaction.processedAt).toBeUndefined();
});

test('não associa referência interna sem referência externa', () => {
  const transaction = WagerTransaction.create(transactionProps());

  expect(() => transaction.markProcessed('unexpected-reference'))
    .toThrow(InvalidWagerTransactionError);

  expect(transaction.status).toBe(WagerTransactionStatus.Pending);
  expect(transaction.processedAt).toBeUndefined();
});

test('não aguarda referência quando nenhuma foi informada', () => {
  const transaction = WagerTransaction.create(transactionProps());

  expect(() => transaction.markPendingReference())
    .toThrow(InvalidWagerTransactionError);

  expect(transaction.status).toBe(WagerTransactionStatus.Pending);
});

test('não repete a transição para PENDING_REFERENCE', () => {
  const transaction = referencedTransaction();
  transaction.markPendingReference();

  expect(() => transaction.markPendingReference())
    .toThrow(InvalidTransactionStateError);
});

test('rejeita operação com código de negócio', () => {
  const transaction = WagerTransaction.create(transactionProps());

  transaction.reject(FailureCode.InsufficientBalance);

  expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
  expect(transaction.failureCode)
    .toBe(FailureCode.InsufficientBalance);
  expect(transaction.processedAt).toBeUndefined();
  expect(transaction.isTerminal()).toBe(true);
});

test('registra falha permanente com código auditável', () => {
  const transaction = WagerTransaction.create(transactionProps());

  transaction.fail(FailureCode.PermanentInfrastructureError);

  expect(transaction.status).toBe(WagerTransactionStatus.Failed);
  expect(transaction.failureCode)
    .toBe(FailureCode.PermanentInfrastructureError);
  expect(transaction.isTerminal()).toBe(true);
});

test.each([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
])('bloqueia todas as transições depois de %s', (status) => {
  const transaction = WagerTransaction.create(transactionProps());

  if (status === WagerTransactionStatus.Processed) {
    transaction.markProcessed(undefined);
  } else if (status === WagerTransactionStatus.Rejected) {
    transaction.reject(FailureCode.InsufficientBalance);
  } else {
    transaction.fail(FailureCode.PermanentInfrastructureError);
  }

  const originalCode = transaction.failureCode;
  const originalDate = transaction.processedAt;

  expect(() => transaction.markProcessed(undefined))
    .toThrow(InvalidTransactionStateError);

  expect(() => transaction.markPendingReference())
    .toThrow(InvalidTransactionStateError);

  expect(() => transaction.reject(FailureCode.InvalidReference))
    .toThrow(InvalidTransactionStateError);

  expect(() => transaction.fail(FailureCode.PermanentInfrastructureError))
    .toThrow(InvalidTransactionStateError);

  expect(transaction.status).toBe(status);
  expect(transaction.failureCode).toBe(originalCode);
  expect(transaction.processedAt).toEqual(originalDate);
});

test('reidrata preservando referência, falha e data de processamento', () => {
  const createdAt = new Date('2026-10-28T12:00:00.000Z');
  const processedAt = new Date('2026-10-28T13:00:00.000Z');

  const processed = WagerTransaction.rehydrate({
    ...transactionProps({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'original-1',
    }),
    status: WagerTransactionStatus.Processed,
    referenceTransactionId: 'internal-original-1',
    createdAt,
    processedAt,
  });

  expect(processed.referenceTransactionId)
    .toBe('internal-original-1');
  expect(processed.processedAt).toEqual(processedAt);

  const rejected = WagerTransaction.rehydrate({
    ...transactionProps(),
    status: WagerTransactionStatus.Rejected,
    failureCode: FailureCode.InsufficientBalance,
    createdAt,
  });

  expect(rejected.failureCode).toBe(FailureCode.InsufficientBalance);
});