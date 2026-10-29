import {
  IsolationLevel,
  LockMode,
  UniqueConstraintViolationException,
} from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { MoneyProps } from "../../domain/money";
import { WagerProcessor } from "../../domain/wager-processor";
import {
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction";
import type {
  CreateWagerTransactionProps,
  FailureCode,
} from "../../domain/wager-transaction";
import { hashWagerPayload } from "../idempotency/wager-payload-hash";
import { WalletRecord } from "./wallet-record";
import { WalletMapper } from "./wallet-mapper";
import { WagerTransactionRecord } from "./wager-transaction-record";
import { WagerTransactionMapper } from "./wager-transaction-mapper";
import { WalletLedgerEntryMapper } from "./wallet-ledger-entry-mapper";
import type {
  EventContext,
  IntegrationEvent,
} from "../../domain/integration-event";
import { OutboxMessage } from "../../domain/outbox-message";
import { WalletBalanceChanged } from "../../domain/wallet-balance-changed";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from "../../domain/wager-transaction-events";
import { OutboxMessageMapper } from "./outbox-message-mapper";

export type ProcessWagerProps = Omit<
  CreateWagerTransactionProps,
  "payloadHash"
>;

export interface WagerProcessingContext {
  correlationId: string;
  causationId?: string;
}

export interface PostgresWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode: FailureCode | undefined;
  idempotentReplay: boolean;
}

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";

  constructor() {
    super("A chave ou operação externa já está associada a outra requisição.");
    this.name = "IdempotencyConflictError";
  }
}

export class PostgresWagerProcessor {
  private readonly domainProcessor = new WagerProcessor();

  constructor(private readonly em: EntityManager) {}

  async process(
    props: ProcessWagerProps,
    entryId: string = crypto.randomUUID(),
    context: WagerProcessingContext = {
      correlationId: crypto.randomUUID(),
    },
  ): Promise<PostgresWagerResult> {
    const payloadHash = hashWagerPayload(props);

    const transaction = WagerTransaction.create({
      ...props,
      payloadHash,
    });

    if (transaction.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError(
        "OPENING deve ser tratado na criação da carteira.",
      );
    }

    const previous = await this.findReplay(this.em.fork(), props, payloadHash);

    if (previous !== undefined) {
      return previous;
    }

    try {
      return await this.em.fork().transactional(
        async (em) => {
          const walletRecord = await em.findOneOrFail(
            WalletRecord,
            { id: transaction.walletId },
            { lockMode: LockMode.PESSIMISTIC_WRITE },
          );

          // Outra execução pode ter confirmado enquanto aguardávamos o lock.
          const replay = await this.findReplay(em, props, payloadHash);

          if (replay !== undefined) {
            return replay;
          }

          const wallet = WalletMapper.toDomain(walletRecord);

          const externalReference = transaction.referenceExternalTransactionId;

          const referenceRecord =
            externalReference === undefined
              ? null
              : await em.findOne(WagerTransactionRecord, {
                  providerId: transaction.providerId,
                  externalTransactionId: externalReference,
                });

          const reference =
            referenceRecord === null
              ? undefined
              : WagerTransactionMapper.toDomain(referenceRecord);

          const reversalAlreadyProcessed =
            transaction.requiresReference() &&
            reference !== undefined &&
            (await em.count(WagerTransactionRecord, {
              referenceTransactionId: reference.id,
              kind: transaction.kind,
              status: WagerTransactionStatus.Processed,
            })) > 0;

          const at = new Date();

          const entry = this.domainProcessor.process({
            transaction,
            wallet,
            entryId,
            reference,
            reversalAlreadyProcessed,
            at,
          });

          walletRecord.balance = wallet.balance.toString();
          walletRecord.version = wallet.version;
          walletRecord.updatedAt = wallet.updatedAt;

          const transactionRecord = WagerTransactionMapper.toRecord(
            transaction,
            wallet.balance,
          );

          em.persist(transactionRecord);
          await em.flush();

          if (entry !== undefined) {
            em.persist(WalletLedgerEntryMapper.toRecord(entry));
          }

          const events: IntegrationEvent<unknown>[] = [
            this.createOutcomeEvent(
              transaction,
              this.eventContext(context, at),
            ),
          ];

          if (entry !== undefined) {
            events.push(
              WalletBalanceChanged.from(
                wallet,
                entry,
                this.eventContext(context, at),
              ),
            );
          }

          for (const event of events) {
            em.persist(
              OutboxMessageMapper.toRecord(OutboxMessage.enqueue(event)),
            );
          }

          return this.toResult(transactionRecord, false);
        },
        {
          isolationLevel: IsolationLevel.READ_COMMITTED,
        },
      );
    } catch (error: unknown) {
      if (!this.isIdempotencyViolation(error)) {
        throw error;
      }

      // A transação anterior já sofreu rollback.
      const replay = await this.findReplay(this.em.fork(), props, payloadHash);

      if (replay === undefined) {
        throw error;
      }

      return replay;
    }
  }

  private eventContext(
    context: WagerProcessingContext,
    at: Date,
  ): EventContext {
    return {
      eventId: crypto.randomUUID(),
      correlationId: context.correlationId,
      causationId: context.causationId,
      occurredAt: at,
    };
  }

  private createOutcomeEvent(
    transaction: WagerTransaction,
    context: EventContext,
  ): IntegrationEvent<unknown> {
    switch (transaction.status) {
      case WagerTransactionStatus.Processed:
        return WagerTransactionProcessed.from(transaction, context);

      case WagerTransactionStatus.Rejected:
        return WagerTransactionRejected.from(transaction, context);

      case WagerTransactionStatus.PendingReference:
        return WagerTransactionPendingReference.from(transaction, context);

      default:
        throw new Error("O processamento terminou em um estado sem evento.");
    }
  }

  private async findReplay(
    em: EntityManager,
    props: ProcessWagerProps,
    payloadHash: string,
  ): Promise<PostgresWagerResult | undefined> {
    const existing = await em.findOne(WagerTransactionRecord, {
      $or: [
        { idempotencyKey: props.idempotencyKey },
        {
          providerId: props.providerId,
          externalTransactionId: props.externalTransactionId,
        },
      ],
    });

    if (existing === null) {
      return undefined;
    }

    if (
      existing.idempotencyKey !== props.idempotencyKey ||
      existing.payloadHash !== payloadHash
    ) {
      throw new IdempotencyConflictError();
    }

    return this.toResult(existing, true);
  }

  private toResult(
    record: WagerTransactionRecord,
    idempotentReplay: boolean,
  ): PostgresWagerResult {
    if (record.resultBalance === null || record.resultCurrency === null) {
      throw new Error("Transação persistida sem saldo de resultado.");
    }

    return {
      transactionId: record.id,
      status: record.status,
      balance: {
        amount: record.resultBalance,
        currency: record.resultCurrency,
      },
      failureCode: record.failureCode ?? undefined,
      idempotentReplay,
    };
  }

  private isIdempotencyViolation(error: unknown): boolean {
    if (!(error instanceof UniqueConstraintViolationException)) {
      return false;
    }

    const constraint = "constraint" in error ? error.constraint : undefined;

    return (
      constraint === "wager_transactions_idempotency_key_unique" ||
      constraint === "wager_transactions_provider_external_unique"
    );
  }
}
