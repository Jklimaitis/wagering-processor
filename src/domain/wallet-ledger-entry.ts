import { Money } from './money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class InvalidLedgerEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLedgerEntryError';
  }
}

export class WalletLedgerEntry {
  public readonly id: string;
  public readonly walletId: string;
  public readonly transactionId: string;
  public readonly direction: LedgerDirection;
  public readonly money: Money;
  public readonly balanceBefore: Money;
  public readonly balanceAfter: Money;

  private readonly createdAtMs: number;     // aqui eu represento o tempo ms nunca valor monetario.

  private constructor(state: LedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.createdAtMs = state.createdAt.getTime();

    Object.freeze(this);
  }

  static create(props: LedgerEntryState): WalletLedgerEntry {
    const ids = [props.id, props.walletId, props.transactionId];

    if (ids.some((id) => id.trim() === '')) {
      throw new InvalidLedgerEntryError(
        'Os identificadores do lançamento são obrigatórios.',
      );
    }

    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError(
        'O valor do lançamento deve ser positivo.',
      );
    }

    if (
      props.balanceBefore.isNegative() ||
      props.balanceAfter.isNegative()
    ) {
      throw new InvalidLedgerEntryError(
        'Os saldos do lançamento não podem ser negativos.',
      );
    }

    const entry = new WalletLedgerEntry(props);

    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        'A direção, as moedas e os saldos devem ser consistentes.',
      );
    }

    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  get createdAt(): Date {
    return new Date(this.createdAtMs);
  }

  isBalanced(): boolean {
    const currency = this.money.currency;

    if (
      this.balanceBefore.currency !== currency ||
      this.balanceAfter.currency !== currency
    ) {
      return false;
    }

    switch (this.direction) {
      case LedgerDirection.Debit:
        return this.balanceBefore
          .subtract(this.balanceAfter)
          .equals(this.money);

      case LedgerDirection.Credit:
        return this.balanceAfter
          .subtract(this.balanceBefore)
          .equals(this.money);

      default:
        return false;
    }
  }
}