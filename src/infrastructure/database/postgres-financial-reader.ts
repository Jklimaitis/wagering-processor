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
import { NotFoundError, QueryOrder } from "@mikro-orm/core";
import { InvalidInputError } from "../../application/input-validation";
import {
  encodeLedgerCursor,
  type LedgerPageRequest,
} from "../../application/ledger-pagination";
import type { LedgerDirection } from "../../domain/wallet-ledger-entry";
import { WalletLedgerEntryRecord } from "./wallet-ledger-entry-record";

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

export interface LedgerEntryView {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPageView {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

interface ReconciliationRow {
  walletId: string;
  currency: string;
  storedBalance: string;
  calculatedBalance: string;
  difference: string;
  consistent: boolean;
  checkedEntries: string;
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

  async listLedger(request: LedgerPageRequest): Promise<LedgerPageView> {
    const { walletId, limit, afterEntryId } = request;

    await this.em.findOneOrFail(
      WalletRecord,
      { id: walletId },
      { fields: ["id"] },
    );

    const query = this.em
      .createQueryBuilder(WalletLedgerEntryRecord, "e")
      .select("*")
      .where({ walletId });

    if (afterEntryId !== undefined) {
      const anchor = await this.em.findOne(
        WalletLedgerEntryRecord,
        { id: afterEntryId, walletId },
        { fields: ["id"] },
      );

      if (anchor === null) {
        throw new InvalidInputError("cursor");
      }

      const namespace = this.em
        .getPlatform()
        .quoteIdentifier(
          this.em.schema ?? this.em.config.get("schema") ?? "public",
        );

      query.andWhere(
        `
          (e.created_at, e.id) > (
            select anchor.created_at, anchor.id
            from ${namespace}.wallet_ledger_entries anchor
            where anchor.wallet_id = ?
              and anchor.id = ?
          )
        `,
        [walletId, afterEntryId],
      );
    }

    const records = await query
      .orderBy({
        createdAt: QueryOrder.ASC,
        id: QueryOrder.ASC,
      })
      .limit(limit + 1)
      .getResultList();

    const page = records.slice(0, limit);
    const last = page.at(-1);

    return {
      items: page.map((record) => ({
        id: record.id,
        walletId: record.walletId,
        transactionId: record.transactionId,
        direction: record.direction,
        money: {
          amount: record.amount,
          currency: record.currency,
        },
        balanceBefore: {
          amount: record.balanceBefore,
          currency: record.currency,
        },
        balanceAfter: {
          amount: record.balanceAfter,
          currency: record.currency,
        },
        createdAt: record.createdAt.toISOString(),
      })),
      nextCursor:
        records.length > limit && last !== undefined
          ? encodeLedgerCursor(walletId, last.id)
          : null,
    };
  }

  async reconcileWallet(walletId: string): Promise<ReconciliationView> {
    const namespace = this.em
      .getPlatform()
      .quoteIdentifier(
        this.em.schema ?? this.em.config.get("schema") ?? "public",
      );

    const [row] = await this.em.execute<ReconciliationRow[]>(
      `
        with ledger_totals as (
          select
            coalesce(
              sum(
                case
                  when direction = 'CREDIT' then amount
                  else -amount
                end
              ),
              0
            ) as balance,
            count(*)::text as checked_entries
          from ${namespace}.wallet_ledger_entries
          where wallet_id = ?
        )
        select
          w.id as "walletId",
          w.currency,
          w.balance::text as "storedBalance",
          round(t.balance, 2)::text as "calculatedBalance",
          round(w.balance - t.balance, 2)::text as difference,
          w.balance = t.balance as consistent,
          t.checked_entries as "checkedEntries"
        from ${namespace}.wallets w
        cross join ledger_totals t
        where w.id = ?
      `,
      [walletId, walletId],
    );

    if (row === undefined) {
      throw NotFoundError.findOneFailed(WalletRecord.name, { id: walletId });
    }

    const checkedEntries = Number(row.checkedEntries);

    if (!Number.isSafeInteger(checkedEntries) || checkedEntries < 0) {
      throw new Error("Contagem do ledger fora do intervalo suportado.");
    }

    return {
      walletId: row.walletId,
      storedBalance: {
        amount: row.storedBalance,
        currency: row.currency,
      },
      calculatedBalance: {
        amount: row.calculatedBalance,
        currency: row.currency,
      },
      difference: {
        amount: row.difference,
        currency: row.currency,
      },
      consistent: row.consistent,
      checkedEntries,
    };
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
