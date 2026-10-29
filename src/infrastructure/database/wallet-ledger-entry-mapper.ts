import { Money } from "../../domain/money";
import { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import { WalletLedgerEntryRecord } from "./wallet-ledger-entry-record";

export class WalletLedgerEntryMapper {
  static toDomain(record: WalletLedgerEntryRecord): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: record.id,
      walletId: record.walletId,
      transactionId: record.transactionId,
      direction: record.direction,

      money: Money.from({
        amount: record.amount,
        currency: record.currency,
      }),

      balanceBefore: Money.from({
        amount: record.balanceBefore,
        currency: record.currency,
      }),

      balanceAfter: Money.from({
        amount: record.balanceAfter,
        currency: record.currency,
      }),

      createdAt: new Date(record.createdAt.getTime()),
    });
  }

  static toRecord(entry: WalletLedgerEntry): WalletLedgerEntryRecord {
    const record = new WalletLedgerEntryRecord();

    record.id = entry.id;
    record.walletId = entry.walletId;
    record.transactionId = entry.transactionId;
    record.direction = entry.direction;
    record.amount = entry.money.toString();
    record.currency = entry.money.currency;
    record.balanceBefore = entry.balanceBefore.toString();
    record.balanceAfter = entry.balanceAfter.toString();
    record.createdAt = entry.createdAt;

    return record;
  }
}
