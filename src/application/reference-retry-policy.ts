import { FailureCode } from "../domain/wager-transaction";

export const MAX_REFERENCE_ATTEMPTS = 10;

export type ReferenceRetryDecision =
  | {
      action: "RETRY";
      nextAttemptAt: Date;
    }
  | {
      action: "REJECT";
      failureCode: FailureCode.ReferenceNotFound;
    };

export function planReferenceRetry(
  attempts: number,
  at: Date,
): ReferenceRetryDecision {
  if (!Number.isSafeInteger(attempts) || attempts < 0) {
    throw new Error("Contador de tentativas de referência inválido.");
  }

  if (!Number.isFinite(at.getTime())) {
    throw new Error("Data de agendamento inválida.");
  }

  if (attempts >= MAX_REFERENCE_ATTEMPTS) {
    return {
      action: "REJECT",
      failureCode: FailureCode.ReferenceNotFound,
    };
  }

  const delaySeconds = Math.min(2 ** attempts, 60);

  return {
    action: "RETRY",
    nextAttemptAt: new Date(at.getTime() + delaySeconds * 1_000),
  };
}
 