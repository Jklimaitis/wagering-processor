import type {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction";

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;

  kind!: WagerTransactionKind;
  amount!: string;
  currency!: string;
  resultBalance!: string | null;
  resultCurrency!: string | null;

  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;

  status!: WagerTransactionStatus;
  failureCode!: FailureCode | null;
  createdAt!: Date;
  processedAt!: Date | null;
}
