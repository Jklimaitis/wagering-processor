import { Money } from "../../domain/money";
import { WagerTransaction } from "../../domain/wager-transaction";
import { WagerTransactionRecord } from "./wager-transaction-record";

export class WagerTransactionMapper {
  static toDomain(record: WagerTransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind,

      money: Money.from({
        amount: record.amount,
        currency: record.currency,
      }),

      referenceExternalTransactionId:
        record.referenceExternalTransactionId ?? undefined,

      referenceTransactionId: record.referenceTransactionId ?? undefined,

      status: record.status,
      failureCode: record.failureCode ?? undefined,
      createdAt: new Date(record.createdAt.getTime()),

      processedAt:
        record.processedAt === null
          ? undefined
          : new Date(record.processedAt.getTime()),
    });
  }

  static toRecord(
    transaction: WagerTransaction,
    observedBalance?: Money,
  ): WagerTransactionRecord {
    const record = new WagerTransactionRecord();

    record.id = transaction.id;
    record.providerId = transaction.providerId;
    record.externalTransactionId = transaction.externalTransactionId;
    record.idempotencyKey = transaction.idempotencyKey;
    record.payloadHash = transaction.payloadHash;
    record.walletId = transaction.walletId;
    record.playerId = transaction.playerId;
    record.roundId = transaction.roundId;
    record.gameId = transaction.gameId;
    record.kind = transaction.kind;

    record.amount = transaction.money.toString();
    record.currency = transaction.money.currency;

    record.resultBalance = observedBalance?.toString() ?? null;

    record.resultCurrency = observedBalance?.currency ?? null;

    record.referenceExternalTransactionId =
      transaction.referenceExternalTransactionId ?? null;

    record.referenceTransactionId = transaction.referenceTransactionId ?? null;

    record.status = transaction.status;
    record.failureCode = transaction.failureCode ?? null;
    record.createdAt = new Date(transaction.createdAt.getTime());

    const processedAt = transaction.processedAt;

    record.processedAt =
      processedAt === undefined ? null : new Date(processedAt.getTime());

    return record;
  }
}

