import { expect, test } from "bun:test";
import {
  InboxMessage,
  InvalidInboxMessageError,
  InvalidInboxStateError,
} from "../../src/domain/inbox-message";

const props = {
  messageId: "message-1",
  consumerName: "wager-consumer",
  payloadHash: "hash-1",
};

test("recebe mensagem ainda não processada", () => {
  const at = new Date("2026-10-29T12:00:00.000Z");

  const message = InboxMessage.receive(props, at);

  expect(message.messageId).toBe("message-1");
  expect(message.consumerName).toBe("wager-consumer");
  expect(message.payloadHash).toBe("hash-1");
  expect(message.receivedAt).toEqual(at);
  expect(message.processedAt).toBeUndefined();
  expect(message.isProcessed()).toBe(false);
});

test("identifica payload igual e divergente", () => {
  const message = InboxMessage.receive(props);

  expect(message.matchesPayload("hash-1")).toBe(true);
  expect(message.matchesPayload("hash-2")).toBe(false);
});

test("marca o processamento uma única vez e preserva a data", () => {
  const message = InboxMessage.receive(
    props,
    new Date("2026-10-29T12:00:00.000Z"),
  );

  const at = new Date("2026-10-29T12:00:01.000Z");

  message.markProcessed(at);
  at.setUTCFullYear(2000);

  expect(message.isProcessed()).toBe(true);
  expect(message.processedAt).toEqual(new Date("2026-10-29T12:00:01.000Z"));

  expect(() => message.markProcessed()).toThrow(InvalidInboxStateError);

  expect(message.processedAt).toEqual(new Date("2026-10-29T12:00:01.000Z"));
});

test("reidrata o estado e protege as datas de alterações externas", () => {
  const receivedAt = new Date("2026-10-29T12:00:00.000Z");
  const processedAt = new Date("2026-10-29T12:00:01.000Z");

  const message = InboxMessage.rehydrate({
    ...props,
    receivedAt,
    processedAt,
  });

  receivedAt.setUTCFullYear(2000);
  processedAt.setUTCFullYear(2000);
  message.receivedAt.setUTCFullYear(2001);
  message.processedAt?.setUTCFullYear(2001);

  expect(message.isProcessed()).toBe(true);
  expect(message.receivedAt).toEqual(new Date("2026-10-29T12:00:00.000Z"));
  expect(message.processedAt).toEqual(new Date("2026-10-29T12:00:01.000Z"));
});

test.each(["messageId", "consumerName", "payloadHash"] as const)(
  "rejeita campo obrigatório vazio: %s",
  (field) => {
    expect(() =>
      InboxMessage.receive({
        ...props,
        [field]: "",
      }),
    ).toThrow(InvalidInboxMessageError);
  },
);
