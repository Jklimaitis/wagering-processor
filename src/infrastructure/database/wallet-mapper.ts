import { Money } from '../../domain/money';
import { Wallet } from '../../domain/wallet';
import { WalletRecord } from './wallet-record';

export class WalletMapper {
  static toDomain(record: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency,
      balance: Money.from({
        amount: record.balance,
        currency: record.currency,
      }),
      version: record.version,
      createdAt: new Date(record.createdAt.getTime()),
      updatedAt: new Date(record.updatedAt.getTime()),
    });
  }

  static toRecord(wallet: Wallet): WalletRecord {
    const record = new WalletRecord();

    record.id = wallet.id;
    record.playerId = wallet.playerId;
    record.currency = wallet.currency;
    record.balance = wallet.balance.toString();
    record.version = wallet.version;
    record.createdAt = new Date(wallet.createdAt.getTime());
    record.updatedAt = new Date(wallet.updatedAt.getTime());

    return record;
  }
}