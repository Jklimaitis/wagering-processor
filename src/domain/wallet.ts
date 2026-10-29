import { CurrencyMismatchError, Money } from './money';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from './wallet-ledger-entry';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}


export class InvalidWalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWalletError';
  }
}


export interface WalletMovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
}


export class InsufficientBalanceError extends Error {
  constructor() {
    super('Saldo insuficiente para realizar o débito.');
    this.name = 'InsufficientBalanceError';
  }
}


export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(
    props: OpenWalletProps,
    at: Date = new Date(),
  ): Wallet {
    if (props.id.trim() === '') {
      throw new InvalidWalletError('O id da carteira é obrigatório.');
    }

    if (props.playerId.trim() === '') {
      throw new InvalidWalletError('O playerId é obrigatório.');
    }

    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError(
        'O saldo inicial não pode ser negativo.',
      );
    }

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      at,
      at,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  debit(
  props: WalletMovementProps,
  at: Date = new Date(),
): WalletLedgerEntry {
  this.assertValidMovement(props.money);

  if (this._balance.isLessThan(props.money)) {
    throw new InsufficientBalanceError();
  }

  const balanceAfter = this._balance.subtract(props.money);

  return this.applyMovement(
    props,
    LedgerDirection.Debit,
    balanceAfter,
    at,
  );
}

credit(
  props: WalletMovementProps,
  at: Date = new Date(),
): WalletLedgerEntry {
  this.assertValidMovement(props.money);

  const balanceAfter = this._balance.add(props.money);

  return this.applyMovement(
    props,
    LedgerDirection.Credit,
    balanceAfter,
    at,
  );
}

private assertValidMovement(money: Money): void {
  if (money.currency !== this.currency) {
    throw new CurrencyMismatchError();
  }

  if (!money.isPositive()) {
    throw new InvalidWalletError(
      'O valor da movimentação deve ser positivo.',
    );
  }
}

private applyMovement(
  props: WalletMovementProps,
  direction: LedgerDirection,
  balanceAfter: Money,
  at: Date,
): WalletLedgerEntry {
  const entry = WalletLedgerEntry.create({
    id: props.entryId,
    walletId: this.id,
    transactionId: props.transactionId,
    direction,
    money: props.money,
    balanceBefore: this._balance,
    balanceAfter,
    createdAt: at,
  });

  this._balance = balanceAfter;
  this._version += 1;
  this._updatedAt = at;

  return entry;
}

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }
}