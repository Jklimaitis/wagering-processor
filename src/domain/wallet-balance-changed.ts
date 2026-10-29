import type { MoneyProps } from "./money";
import type { Wallet } from "./wallet";
import type { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";
import {
  IntegrationEvent,
  InvalidIntegrationEventError,
} from "./integration-event";
import type { EventContext, IntegrationEventProps } from "./integration-event";

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  override readonly eventType = "WalletBalanceChanged";
  override readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
    Object.freeze(this);
  }

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    ctx: EventContext,
  ): WalletBalanceChanged {
    if (
      wallet.id !== entry.walletId ||
      wallet.currency !== entry.money.currency ||
      !wallet.balance.equals(entry.balanceAfter)
    ) {
      throw new InvalidIntegrationEventError(
        "O lançamento não corresponde ao estado da wallet.",
      );
    }

    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
