import { createHash } from "node:crypto";
import type { CreateWagerTransactionProps } from "../../domain/wager-transaction";

export type WagerBusinessPayload = Pick<
  CreateWagerTransactionProps,
  | "providerId"
  | "externalTransactionId"
  | "walletId"
  | "playerId"
  | "roundId"
  | "gameId"
  | "kind"
  | "money"
  | "referenceExternalTransactionId"
>;

export function hashWagerPayload(input: WagerBusinessPayload): string {
  // Campos de negócio em ordem alfabética explícita.
  const canonicalPayload = {
    externalTransactionId: input.externalTransactionId,
    gameId: input.gameId,
    kind: input.kind,
    money: {
      amount: input.money.toString(),
      currency: input.money.currency,
    },
    playerId: input.playerId,
    providerId: input.providerId,
    referenceExternalTransactionId: input.referenceExternalTransactionId,
    roundId: input.roundId,
    walletId: input.walletId,
  };

  return createHash("sha256")
    .update(JSON.stringify(canonicalPayload), "utf8")
    .digest("hex");
}
