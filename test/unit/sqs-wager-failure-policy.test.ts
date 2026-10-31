import { expect, test } from "bun:test";
import { InvalidInputError } from "../../src/application/input-validation";
import { InvalidMoneyError } from "../../src/domain/money";
import { InvalidWagerTransactionError } from "../../src/domain/wager-transaction";
import { InboxPayloadConflictError } from "../../src/infrastructure/database/postgres-inbox-wager-processor";
import { IdempotencyConflictError } from "../../src/infrastructure/database/postgres-wager-processor";
import {
  decideSqsFailure,
  MAX_SQS_ATTEMPTS,
} from "../../src/infrastructure/messaging/sqs-wager-failure-policy";

const permanentCases = [
  ["entrada inválida", new InvalidInputError("walletId"), "INVALID_INPUT"],
  [
    "dinheiro inválido",
    new InvalidMoneyError("Valor inválido."),
    "INVALID_OPERATION",
  ],
  [
    "operação inválida",
    new InvalidWagerTransactionError("Referência obrigatória."),
    "INVALID_OPERATION",
  ],
  [
    "conflito financeiro",
    new IdempotencyConflictError(),
    "IDEMPOTENCY_CONFLICT",
  ],
  [
    "conflito na inbox",
    new InboxPayloadConflictError(),
    "INBOX_PAYLOAD_CONFLICT",
  ],
] as const;

test.each(permanentCases)(
  "envia erro permanente para DLQ na primeira tentativa: %s",
  (_name, error, reason) => {
    expect(decideSqsFailure(error, "1")).toEqual({
      action: "DLQ",
      attempt: 1,
      reason,
    });
  },
);

const backoffCases: Array<[string, number]> = [
  ["1", 1],
  ["2", 2],
  ["3", 4],
  ["4", 8],
];

test.each(backoffCases)(
  "agenda retry transitório na tentativa %s",
  (receiveCount, delaySeconds) => {
    const error = Object.assign(new Error("Deadlock simulado."), {
      code: "40P01",
    });

    expect(decideSqsFailure(error, receiveCount)).toEqual({
      action: "RETRY",
      attempt: Number(receiveCount),
      delaySeconds,
      reason: "TRANSIENT_ERROR",
    });
  },
);

test.each(["5", "12"])(
  "envia para DLQ ao atingir ou ultrapassar o limite: %s",
  (receiveCount) => {
    expect(MAX_SQS_ATTEMPTS).toBe(5);

    expect(
      decideSqsFailure(new Error("Banco indisponível."), receiveCount),
    ).toEqual({
      action: "DLQ",
      attempt: Number(receiveCount),
      reason: "RETRIES_EXHAUSTED",
    });
  },
);

test.each([
  undefined,
  "",
  "0",
  "-1",
  "1.5",
  "NaN",
  "1e2",
  " 1",
  "9007199254740992",
])("rejeita contador inválido: %j", (receiveCount) => {
  expect(() =>
    decideSqsFailure(new Error("Falha transitória."), receiveCount),
  ).toThrow();
});
