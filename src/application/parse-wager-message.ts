import { InvalidInputError, readObject, readString } from "./input-validation";
import {
  parseWagerRequest,
  type ParsedWagerRequest,
} from "./parse-wager-request";

export interface ParsedWagerMessage {
  messageId: string;
  type: "WagerTransactionRequested";
  occurredAt: Date;
  correlationId: string;
  data: ParsedWagerRequest;
}

function readOccurredAt(value: unknown): Date {
  const text = readString(value, "occurredAt");

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text)) {
    throw new InvalidInputError("occurredAt");
  }

  const date = new Date(text);

  const canonical = text.includes(".") ? text : text.replace("Z", ".000Z");

  if (!Number.isFinite(date.getTime()) || date.toISOString() !== canonical) {
    throw new InvalidInputError("occurredAt");
  }

  return date;
}

export function parseWagerMessage(
  body: string | undefined,
): ParsedWagerMessage {
  const text = readString(body, "body");
  let decoded: unknown;

  try {
    decoded = JSON.parse(text);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw new InvalidInputError("body");
    }

    throw error;
  }

  const input = readObject(decoded, "message");

  if (input.type !== "WagerTransactionRequested") {
    throw new InvalidInputError("type");
  }

  const messageId = readString(input.messageId, "messageId");
  const data = readObject(input.data, "data");

  return {
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: readOccurredAt(input.occurredAt),
    correlationId:
      input.correlationId === undefined
        ? messageId
        : readString(input.correlationId, "correlationId"),
    data: parseWagerRequest(data, data.idempotencyKey),
  };
}
