import { DecimalType, EntitySchema } from "@mikro-orm/core";
import { LedgerDirection } from "../../domain/wallet-ledger-entry";
import { WalletLedgerEntryRecord } from "./wallet-ledger-entry-record";

export const WalletLedgerEntrySchema =
  new EntitySchema<WalletLedgerEntryRecord>({
    class: WalletLedgerEntryRecord,
    tableName: "wallet_ledger_entries",
    schema: "*",

    properties: {
      id: {
        type: "uuid",
        primary: true,
      },
      walletId: {
        type: "uuid",
        fieldName: "wallet_id",
      },
      transactionId: {
        type: "uuid",
        fieldName: "transaction_id",
      },
      direction: {
        enum: true,
        items: Object.values(LedgerDirection),
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
      balanceBefore: {
        type: new DecimalType("string"),
        precision: 20,
        scale: 2,
        fieldName: "balance_before",
      },
      balanceAfter: {
        type: new DecimalType("string"),
        precision: 20,
        scale: 2,
        fieldName: "balance_after",
      },
      createdAt: {
        type: Date,
        columnType: "timestamptz",
        fieldName: "created_at",
      },
    },

    uniques: [
      {
        name: "wallet_ledger_entries_wallet_transaction_unique", // constraint unica para garantir que não haja entradas duplicadas para a mesma transação em uma carteira
        properties: ["walletId", "transactionId"],
      },
    ],

    indexes: [
      {
        name: "wallet_ledger_entries_wallet_created_idx", // índice para otimizar consultas por carteira e data de criação
        properties: ["walletId", "createdAt", "id"],
      },
    ],

    checks: [
      {
        name: "wallet_ledger_entries_currency_supported", // constraint para garantir que a moeda seja suportada
        expression: "currency in ('BRL', 'USD')",
      },
      {
        name: "wallet_ledger_entries_amount_valid", // constraint para garantir que o valor seja positivo e não exceda 999999999999999999.99
        expression: `
          amount > 0
          and amount <= 999999999999999999.99
        `,
      },
      {
        name: "wallet_ledger_entries_balances_valid", // constraint para garantir que os saldos antes e depois da transação sejam válidos
        expression: `
          balance_before >= 0
          and balance_before <= 999999999999999999.99
          and balance_after >= 0
          and balance_after <= 999999999999999999.99
        `,
      },
      {
        name: "wallet_ledger_entries_balanced", // constraint para garantir que o saldo após a transação seja consistente com a direção da transação e o valor
        expression: `
          (
            direction = 'DEBIT'
            and balance_after = balance_before - amount
          )
          or (
            direction = 'CREDIT'
            and balance_after = balance_before + amount
          )
        `,
      },
    ],
  });
