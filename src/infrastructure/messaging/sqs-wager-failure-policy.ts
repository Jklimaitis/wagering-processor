import { InvalidInputError } from "../../application/input-validation";
import { InvalidMoneyError } from "../../domain/money";
import { InvalidWagerTransactionError } from "../../domain/wager-transaction";
import { InboxPayloadConflictError } from "../database/postgres-inbox-wager-processor";
import { IdempotencyConflictError } from "../database/postgres-wager-processor";
import { SqsAcknowledgementError } from "./sqs-wager-message-handler";

export const MAX_SQS_ATTEMPTS = 5;

type PermanentFailureReason =
  | "INVALID_INPUT"
  | "INVALID_OPERATION"
  | "IDEMPOTENCY_CONFLICT"
  | "INBOX_PAYLOAD_CONFLICT";

export type SqsFailureDecision =
  | {
      action: "RETRY";
      attempt: number;
      delaySeconds: number;
      reason: "TRANSIENT_ERROR" | "ACK_FAILED_AFTER_COMMIT";
    }
  | {
      action: "DLQ";
      attempt: number;
      reason:
        | PermanentFailureReason
        | "RETRIES_EXHAUSTED"
        | "ACK_FAILED_AFTER_COMMIT";
    };

function permanentFailureReason(
  error: unknown,
): PermanentFailureReason | undefined {
  if (error instanceof InvalidInputError) {
    return "INVALID_INPUT";
  }

  if (
    error instanceof InvalidMoneyError ||
    error instanceof InvalidWagerTransactionError
  ) {
    return "INVALID_OPERATION";
  }

  if (error instanceof IdempotencyConflictError) {
    return "IDEMPOTENCY_CONFLICT";
  }

  if (error instanceof InboxPayloadConflictError) {
    return "INBOX_PAYLOAD_CONFLICT";
  }

  return undefined;
}

export function decideSqsFailure(
  error: unknown,
  receiveCount: string | undefined,
): SqsFailureDecision {
  if (typeof receiveCount !== "string" || !/^[1-9][0-9]*$/.test(receiveCount)) {
    throw new Error("ApproximateReceiveCount inválido ou ausente.");
  }

  const attempt = Number(receiveCount);

  if (!Number.isSafeInteger(attempt)) {
    throw new Error("ApproximateReceiveCount fora do intervalo seguro.");
  }

  const permanentReason = permanentFailureReason(error);

  if (permanentReason !== undefined) {
    return {
      action: "DLQ",
      attempt,
      reason: permanentReason,
    };
  }

  const acknowledgementFailed = error instanceof SqsAcknowledgementError;

  if (attempt >= MAX_SQS_ATTEMPTS) {
    return {
      action: "DLQ",
      attempt,
      reason: acknowledgementFailed
        ? "ACK_FAILED_AFTER_COMMIT"
        : "RETRIES_EXHAUSTED",
    };
  }

  return {
    action: "RETRY",
    attempt,
    delaySeconds: Math.min(2 ** (attempt - 1), 60),
    reason: acknowledgementFailed
      ? "ACK_FAILED_AFTER_COMMIT"
      : "TRANSIENT_ERROR",
  };
}
