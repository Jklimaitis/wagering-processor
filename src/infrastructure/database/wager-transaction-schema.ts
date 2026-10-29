import { DecimalType, EntitySchema } from "@mikro-orm/core";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction";
import { WagerTransactionRecord } from "./wager-transaction-record";

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: "wager_transactions",
  schema: "*",

  properties: {
    id: {
      type: "uuid",
      primary: true,
    },
    providerId: {
      type: "text",
      fieldName: "provider_id",
    },
    externalTransactionId: {
      type: "text",
      fieldName: "external_transaction_id",
    },
    idempotencyKey: {
      type: "text",
      fieldName: "idempotency_key",
    },
    payloadHash: {
      type: "text",
      fieldName: "payload_hash",
    },
    walletId: {
      type: "uuid",
      fieldName: "wallet_id",
    },
    playerId: {
      type: "uuid",
      fieldName: "player_id",
    },
    roundId: {
      type: "text",
      fieldName: "round_id",
    },
    gameId: {
      type: "text",
      fieldName: "game_id",
    },
    kind: {
      enum: true,
      items: Object.values(WagerTransactionKind),
    },
    amount: {
      type: new DecimalType("string"),
      precision: 20,
      scale: 2,
    },
    currency: {
      type: "string",
      length: 3,
    },
    resultBalance: {
      type: new DecimalType("string"),
      precision: 20,
      scale: 2,
      fieldName: "result_balance",
      nullable: true,
    },
    resultCurrency: {
      type: "string",
      length: 3,
      fieldName: "result_currency",
      nullable: true,
    },
    referenceExternalTransactionId: {
      type: "text",
      fieldName: "reference_external_transaction_id",
      nullable: true,
    },
    referenceTransactionId: {
      type: "uuid",
      fieldName: "reference_transaction_id",
      nullable: true,
    },
    status: {
      enum: true,
      items: Object.values(WagerTransactionStatus),
    },
    failureCode: {
      enum: true,
      items: Object.values(FailureCode),
      fieldName: "failure_code",
      nullable: true,
    },
    createdAt: {
      type: Date,
      columnType: "timestamptz",
      fieldName: "created_at",
    },
    processedAt: {
      type: Date,
      columnType: "timestamptz",
      fieldName: "processed_at",
      nullable: true,
    },
  },

  uniques: [
    {
      name: "wager_transactions_idempotency_key_unique", //chave global de idempotência, não por carteira, para evitar duplicidade de transações entre carteiras diferentes
      properties: ["idempotencyKey"],
    },
    {
      name: "wager_transactions_provider_external_unique", //chave única por provedor e transação externa, para evitar duplicidade de transações entre carteiras diferentes
      properties: ["providerId", "externalTransactionId"],
    },
    {
      name: "wager_transactions_processed_reversal_unique", //chave única para transações de reversão (REFUND e ROLLBACK) processadas, para evitar duplicidade de reversões
      properties: ["referenceTransactionId", "kind"],
      where: "status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')",
    },
    {
      name: "wager_transactions_id_wallet_currency_unique", // Permite que a chave composta FK do ledger valide conjuntamente a transação, a carteira e a moeda, evitando que uma transação seja registrada em uma carteira diferente da original ou com uma moeda diferente da original
      properties: ["id", "walletId", "currency"],
    },
  ],

  indexes: [
    {
      name: "wager_transactions_wallet_created_idx",
      properties: ["walletId", "createdAt", "id"],
    },
  ],

  checks: [
    {
      name: "wager_transactions_currency_supported",
      expression: "currency in ('BRL', 'USD')",
    },
    {
      name: "wager_transactions_amount_valid",
      expression: `
          amount >= 0
          and amount <= 999999999999999999.99
          and (kind = 'LOSS' or amount > 0)
        `,
    },
    {
      name: "wager_transactions_reference_required",
      expression: `
          kind not in ('REFUND', 'ROLLBACK')
          or (
            reference_external_transaction_id is not null
            and length(trim(reference_external_transaction_id)) > 0
          )
        `,
    },
    {
      name: "wager_transactions_processed_at_consistent",
      expression: `
          (status = 'PROCESSED') = (processed_at is not null)
        `,
    },
    {
      name: "wager_transactions_failure_code_consistent",
      expression: `
          (status in ('REJECTED', 'FAILED'))
          = (failure_code is not null)
        `,
    },
    {
      name: "wager_transactions_processed_reference_consistent",
      expression: `
          status <> 'PROCESSED'
          or (
            (reference_external_transaction_id is null)
            = (reference_transaction_id is null)
          )
        `,
    },
    {
      name: "wager_transactions_result_balance_valid",
      expression: `
          (
            result_balance is null
            and result_currency is null
          )
          or (
            result_balance is not null
            and result_currency is not null
            and result_balance >= 0
            and result_balance <= 999999999999999999.99
            and result_currency in ('BRL', 'USD')
          )
        `,
    },
  ],
});
