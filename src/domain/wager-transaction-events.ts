import type { MoneyProps } from "./money";
import {
  IntegrationEvent,
  InvalidIntegrationEventError,
} from "./integration-event";
import type { EventContext, IntegrationEventProps } from "./integration-event";
import { WagerTransactionStatus } from "./wager-transaction";
import type {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
} from "./wager-transaction";

export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
}

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  status: WagerTransactionStatus.Processed;
  processedAt: string;
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  status: WagerTransactionStatus.Rejected;
  failureCode: FailureCode;
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  status: WagerTransactionStatus.PendingReference;
  referenceExternalTransactionId: string;
}

function transactionData(
  transaction: WagerTransaction,
): WagerTransactionEventData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    referenceTransactionId: transaction.referenceTransactionId,
  };
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  override readonly eventType = "WagerTransactionProcessed";
  override readonly version = 1;

  private constructor(
    props: IntegrationEventProps<WagerTransactionProcessedData>,
  ) {
    super(props);
    Object.freeze(this);
  }

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    const processedAt = transaction.processedAt;

    if (
      transaction.status !== WagerTransactionStatus.Processed ||
      processedAt === undefined
    ) {
      throw new InvalidIntegrationEventError(
        "O evento exige uma transação PROCESSED com data.",
      );
    }

    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...transactionData(transaction),
        status: WagerTransactionStatus.Processed,
        processedAt: processedAt.toISOString(),
      },
    });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  override readonly eventType = "WagerTransactionRejected";
  override readonly version = 1;

  private constructor(
    props: IntegrationEventProps<WagerTransactionRejectedData>,
  ) {
    super(props);
    Object.freeze(this);
  }

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionRejected {
    const failureCode = transaction.failureCode;

    if (
      transaction.status !== WagerTransactionStatus.Rejected ||
      failureCode === undefined
    ) {
      throw new InvalidIntegrationEventError(
        "O evento exige uma transação REJECTED com failureCode.",
      );
    }

    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...transactionData(transaction),
        status: WagerTransactionStatus.Rejected,
        failureCode,
      },
    });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  override readonly eventType = "WagerTransactionPendingReference";
  override readonly version = 1;

  private constructor(
    props: IntegrationEventProps<WagerTransactionPendingReferenceData>,
  ) {
    super(props);
    Object.freeze(this);
  }

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    const referenceExternalTransactionId =
      transaction.referenceExternalTransactionId;

    if (
      transaction.status !== WagerTransactionStatus.PendingReference ||
      referenceExternalTransactionId === undefined
    ) {
      throw new InvalidIntegrationEventError(
        "O evento exige uma transação PENDING_REFERENCE com referência.",
      );
    }

    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...transactionData(transaction),
        status: WagerTransactionStatus.PendingReference,
        referenceExternalTransactionId,
      },
    });
  }
}
