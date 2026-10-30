import type { EntityManager } from "@mikro-orm/postgresql";
import type { MoneyProps } from "../../domain/money";
import type {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction";
import type { WalletView } from "./postgres-wallet-creator";
import { WagerTransactionRecord } from "./wager-transaction-record";
import { WalletRecord } from "./wallet-record";

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  balance: MoneyProps | null;
  failureCode: FailureCode | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  createdAt: string;
  processedAt: string | null;
}

export class PostgresFinancialReader {
  constructor(private readonly em: EntityManager) {}

  async findWallet(walletId: string): Promise<WalletView> {
    const record = await this.em.findOneOrFail(WalletRecord, {
      id: walletId,
    });

    return {
      id: record.id,
      playerId: record.playerId,
      balance: {
        amount: record.balance,
        currency: record.currency,
      },
      version: record.version,
    };
  }

  async findTransactionById(
    transactionId: string,
  ): Promise<WagerTransactionView> {
    const record = await this.em.findOneOrFail(WagerTransactionRecord, {
      id: transactionId,
    });

    return this.transactionView(record);
  }

  async findTransactionByProvider(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    const record = await this.em.findOneOrFail(WagerTransactionRecord, {
      providerId,
      externalTransactionId,
    });

    return this.transactionView(record);
  }

  private transactionView(
    record: WagerTransactionRecord,
  ): WagerTransactionView {
    return {
      transactionId: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind,
      money: {
        amount: record.amount,
        currency: record.currency,
      },
      status: record.status,
      balance:
        record.resultBalance === null || record.resultCurrency === null
          ? null
          : {
              amount: record.resultBalance,
              currency: record.resultCurrency,
            },
      failureCode: record.failureCode,
      referenceExternalTransactionId: record.referenceExternalTransactionId,
      referenceTransactionId: record.referenceTransactionId,
      createdAt: record.createdAt.toISOString(),
      processedAt: record.processedAt?.toISOString() ?? null,
    };
  }
}
