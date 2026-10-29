import { InvalidMoneyError, Money } from "../domain/money";
import {
  WagerTransactionKind,
  type CreateWagerTransactionProps,
} from "../domain/wager-transaction";
import {
  InvalidInputError,
  readObject,
  readString,
  readUuid,
} from "./input-validation";

export type ParsedWagerRequest = Omit<
  CreateWagerTransactionProps,
  "id" | "payloadHash"
>;

function readKind(value: unknown): WagerTransactionKind {
  switch (value) {
    case WagerTransactionKind.Bet:
    case WagerTransactionKind.Win:
    case WagerTransactionKind.Loss:
    case WagerTransactionKind.Refund:
    case WagerTransactionKind.Rollback:
      return value;

    default:
      throw new InvalidInputError("kind");
  }
}

function readMoney(value: unknown): Money {
  const input = readObject(value, "money");

  try {
    return Money.from({
      amount: readString(input.amount, "money.amount"),
      currency: readString(input.currency, "money.currency"),
    });
  } catch (error: unknown) {
    if (error instanceof InvalidMoneyError) {
      throw new InvalidInputError("money");
    }

    throw error;
  }
}

export function parseWagerRequest(
  value: unknown,
  idempotencyKey: unknown,
): ParsedWagerRequest {
  const input = readObject(value, "body");

  return {
    providerId: readString(input.providerId, "providerId"),
    externalTransactionId: readString(
      input.externalTransactionId,
      "externalTransactionId",
    ),
    idempotencyKey: readString(idempotencyKey, "idempotencyKey"),
    walletId: readUuid(input.walletId, "walletId"),
    playerId: readUuid(input.playerId, "playerId"),
    roundId: readString(input.roundId, "roundId"),
    gameId: readString(input.gameId, "gameId"),
    kind: readKind(input.kind),
    money: readMoney(input.money),
    referenceExternalTransactionId:
      input.referenceExternalTransactionId === undefined
        ? undefined
        : readString(
            input.referenceExternalTransactionId,
            "referenceExternalTransactionId",
          ),
  };
}
