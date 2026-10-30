import {
  InvalidInputError,
  readObject,
  readString,
  readUuid,
} from "./input-validation";

export interface LedgerPageRequest {
  walletId: string;
  limit: number;
  afterEntryId?: string;
}

export function encodeLedgerCursor(walletId: string, entryId: string): string {
  return Buffer.from(
    JSON.stringify({ v: 1, walletId, entryId }),
    "utf8",
  ).toString("base64url");
}

export function parseLedgerPage(
  walletIdValue: unknown,
  cursorValue: unknown,
  limitValue: unknown,
): LedgerPageRequest {
  const walletId = readUuid(walletIdValue, "walletId");

  let limit = 50;

  if (limitValue !== undefined) {
    if (
      typeof limitValue !== "string" ||
      !/^[1-9][0-9]{0,2}$/.test(limitValue)
    ) {
      throw new InvalidInputError("limit");
    }

    limit = Number(limitValue);

    if (limit > 100) {
      throw new InvalidInputError("limit");
    }
  }

  let afterEntryId: string | undefined;

  if (cursorValue !== undefined) {
    const cursor = readString(cursorValue, "cursor");

    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new InvalidInputError("cursor");
    }

    try {
      const bytes = Buffer.from(cursor, "base64url");

      if (bytes.toString("base64url") !== cursor) {
        throw new InvalidInputError("cursor");
      }

      const decoded = readObject(JSON.parse(bytes.toString("utf8")), "cursor");

      if (
        decoded.v !== 1 ||
        readUuid(decoded.walletId, "cursor") !== walletId
      ) {
        throw new InvalidInputError("cursor");
      }

      afterEntryId = readUuid(decoded.entryId, "cursor");
    } catch {
      throw new InvalidInputError("cursor");
    }
  }

  return { walletId, limit, afterEntryId };
}
