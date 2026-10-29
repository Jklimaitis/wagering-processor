import { InvalidMoneyError } from './money';
import { InsufficientBalanceError, Wallet } from './wallet';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from './wallet-ledger-entry';
import {
  FailureCode,
  InvalidReferenceError,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  ReferenceNotReadyError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';

export interface ProcessWagerInput {
  transaction: WagerTransaction;
  wallet: Wallet;
  entryId: string;
  reference?: WagerTransaction;
  reversalAlreadyProcessed: boolean;
  at?: Date;
}

export class WagerProcessor {
  process(input: ProcessWagerInput): WalletLedgerEntry | undefined {
    const {
      transaction,
      wallet,
      entryId,
      reference,
      reversalAlreadyProcessed, //campo interno, virá de uma consulta ao Postgre considerando o tipo de reversão
      at = new Date(),
    } = input;

    if (transaction.isTerminal()) {
      throw new InvalidTransactionStateError(
        'Uma transação terminal não pode ser reaplicada.',
      );
    }

    if (transaction.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError(
        'OPENING deve ser tratado na criação da carteira.',
      );
    }

    if (transaction.walletId !== wallet.id) {
      return this.reject(transaction, FailureCode.WalletMismatch);
    }

    if (transaction.playerId !== wallet.playerId) {
      return this.reject(transaction, FailureCode.PlayerMismatch);
    }

    if (transaction.money.currency !== wallet.currency) {
      return this.reject(transaction, FailureCode.CurrencyMismatch);
    }

    try {
      if (!transaction.affectsBalance()) {
        if (
          transaction.referenceExternalTransactionId !== undefined ||
          reference !== undefined
        ) {
          return this.reject(
            transaction,
            FailureCode.InvalidReference,
          );
        }

        transaction.markProcessed(undefined, at);
        return undefined;
      }

      const direction = transaction.ledgerDirectionFor(reference);

      if (
        transaction.requiresReference() &&
        reversalAlreadyProcessed
      ) {
        return this.reject(
          transaction,
          FailureCode.AlreadyReversed,
        );
      }

      const movement = {
        entryId,
        transactionId: transaction.id,
        money: transaction.money,
      };

      const entry = direction === LedgerDirection.Debit
        ? wallet.debit(movement, at)
        : wallet.credit(movement, at);

      transaction.markProcessed(reference?.id, at);

      return entry;
    } catch (error: unknown) {
      if (error instanceof ReferenceNotReadyError) {
        if (transaction.status === WagerTransactionStatus.Pending) {
          transaction.markPendingReference();
        }

        return undefined;
      }

      if (error instanceof InvalidReferenceError) {
        return this.reject(
          transaction,
          FailureCode.InvalidReference,
        );
      }

      if (error instanceof InsufficientBalanceError) {
        const code = transaction.requiresReference()
          ? FailureCode.InsufficientBalanceForReversal
          : FailureCode.InsufficientBalance;

        return this.reject(transaction, code);
      }

      if (error instanceof InvalidMoneyError) {
        return this.reject(
          transaction,
          FailureCode.MonetaryLimitExceeded,
        );
      }

      throw error;
    }
  }

  private reject(
    transaction: WagerTransaction,
    code: FailureCode,
  ): undefined {
    transaction.reject(code);
    return undefined;
  }
}