import { EntitySchema, PrimaryKeyProp } from "@mikro-orm/core";

export class InboxMessageRecord {
  [PrimaryKeyProp]?: ["consumerName", "messageId"]; // pk composta para o caso de múltiplos consumidores processando a mesma mensagem

  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: "inbox_messages",
  schema: "*",

  properties: {
    consumerName: {
      type: "text",
      fieldName: "consumer_name",
      primary: true,
    },
    messageId: {
      type: "text",
      fieldName: "message_id",
      primary: true,
    },
    payloadHash: {
      type: "text",
      fieldName: "payload_hash",
    },
    receivedAt: {
      type: Date,
      columnType: "timestamptz",
      fieldName: "received_at",
    },
    processedAt: {
      type: Date,
      columnType: "timestamptz",
      fieldName: "processed_at",
      nullable: true,
    },
  },

  checks: [
    {
      name: "inbox_messages_required_values",
      expression: `
          length(trim(consumer_name)) > 0
          and length(trim(message_id)) > 0
          and length(trim(payload_hash)) > 0
        `,
    },
  ],
});
