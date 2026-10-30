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
import { planReferenceRetry } from "../../application/reference-retry-policy";
import type { Wallet } from "../../domain/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";

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

interface ReferenceReprocessProgress {
  transactionId: string;
  walletId: string;
  providerId: string;
  correlationId: string;
  attempts: number;
  messageId: string | null;
}

export type PendingReferenceResult =
  | { status: "IDLE" }
  | (ReferenceReprocessProgress & {
      status: "RESCHEDULED";
      nextAttemptAt: Date;
    })
  | (ReferenceReprocessProgress & {
      status: "COMPLETED";
      result: PostgresWagerResult;
    });

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

    const previous = await this.findReplay(
      this.em.fork({ keepTransactionContext: true }),
      props,
      payloadHash,
    );

    if (previous !== undefined) {
      return previous;
    }

    try {
      return await this.em.fork({ keepTransactionContext: true }).transactional(
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

          const { wallet, entry, at } = await this.applyDomainTransaction(
            em,
            transaction,
            walletRecord,
            entryId,
          );

          walletRecord.balance = wallet.balance.toString();
          walletRecord.version = wallet.version;
          walletRecord.updatedAt = wallet.updatedAt;

          const transactionRecord = WagerTransactionMapper.toRecord(
            transaction,
            wallet.balance,
          );

          transactionRecord.correlationId = context.correlationId;
          transactionRecord.causationId = context.causationId ?? null;

          if (transaction.status === WagerTransactionStatus.PendingReference) {
            const schedule = planReferenceRetry(0, at);

            if (schedule.action !== "RETRY") {
              throw new Error("Primeira tentativa deveria ser agendada.");
            }

            transactionRecord.nextReferenceAttemptAt = schedule.nextAttemptAt;
          }

          em.persist(transactionRecord);
          await em.flush();

          this.persistLedgerAndEvents(
            em,
            transaction,
            wallet,
            entry,
            context,
            at,
          );

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
      const replay = await this.findReplay(
        this.em.fork({ keepTransactionContext: true }),
        props,
        payloadHash,
      );

      if (replay === undefined) {
        throw error;
      }

      return replay;
    }
  }

  async reprocessNextPendingReference(
    at: Date = new Date(),
  ): Promise<PendingReferenceResult> {
    const now = new Date(at.getTime());

    if (!Number.isFinite(now.getTime())) {
      throw new Error("Data de reprocessamento inválida.");
    }

    return this.em.fork().transactional<PendingReferenceResult>(
      async (em) => {
        const namespace = em
          .getPlatform()
          .quoteIdentifier(em.schema ?? em.config.get("schema") ?? "public");

        const [candidate] = await em.execute<{ id: string }[]>(
          `
            select t.id
            from ${namespace}.wager_transactions t
            join ${namespace}.wallets w on w.id = t.wallet_id
            where t.status = 'PENDING_REFERENCE'
              and (
                t.next_reference_attempt_at is null
                or t.next_reference_attempt_at <= ?
              )
            order by
              t.next_reference_attempt_at asc nulls first,
              t.created_at,
              t.id
            limit 1
            for update of w skip locked
          `,
          [now],
        );

        if (candidate === undefined) {
          return { status: "IDLE" };
        }

        const record = await em.findOneOrFail(
          WagerTransactionRecord,
          { id: candidate.id },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );

        if (
          record.status !== WagerTransactionStatus.PendingReference ||
          (record.nextReferenceAttemptAt !== null &&
            record.nextReferenceAttemptAt.getTime() > now.getTime())
        ) {
          return { status: "IDLE" };
        }

        // A consulta anterior já bloqueou esta wallet.
        const walletRecord = await em.findOneOrFail(WalletRecord, {
          id: record.walletId,
        });

        const transaction = WagerTransactionMapper.toDomain(record);

        const { wallet, entry } = await this.applyDomainTransaction(
          em,
          transaction,
          walletRecord,
          crypto.randomUUID(),
          now,
        );

        record.referenceAttempts += 1;

        const context: WagerProcessingContext = {
          correlationId: record.correlationId ?? record.id,
          causationId: record.causationId ?? record.id,
        };

        record.correlationId = context.correlationId;
        record.causationId = context.causationId ?? null;

        const progress: ReferenceReprocessProgress = {
          transactionId: record.id,
          walletId: record.walletId,
          providerId: record.providerId,
          correlationId: context.correlationId,
          attempts: record.referenceAttempts,
          messageId: record.causationId,
        };

        if (transaction.status === WagerTransactionStatus.PendingReference) {
          const decision = planReferenceRetry(record.referenceAttempts, now);

          if (decision.action === "RETRY") {
            record.nextReferenceAttemptAt = decision.nextAttemptAt;

            return {
              status: "RESCHEDULED",
              ...progress,
              nextAttemptAt: decision.nextAttemptAt,
            };
          }

          transaction.reject(decision.failureCode);
        }

        walletRecord.balance = wallet.balance.toString();
        walletRecord.version = wallet.version;
        walletRecord.updatedAt = wallet.updatedAt;

        const updated = WagerTransactionMapper.toRecord(
          transaction,
          wallet.balance,
        );

        record.status = updated.status;
        record.failureCode = updated.failureCode;
        record.referenceTransactionId = updated.referenceTransactionId;
        record.processedAt = updated.processedAt;
        record.resultBalance = updated.resultBalance;
        record.resultCurrency = updated.resultCurrency;
        record.nextReferenceAttemptAt = null;

        this.persistLedgerAndEvents(
          em,
          transaction,
          wallet,
          entry,
          context,
          now,
        );

        return {
          status: "COMPLETED",
          ...progress,
          result: this.toResult(record, false),
        };
      },
      {
        isolationLevel: IsolationLevel.READ_COMMITTED,
      },
    );
  }

  private async applyDomainTransaction(
    em: EntityManager,
    transaction: WagerTransaction,
    walletRecord: WalletRecord,
    entryId: string,
    processingAt?: Date,
  ): Promise<{
    wallet: Wallet;
    entry: WalletLedgerEntry | undefined;
    at: Date;
  }> {
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

    const at = processingAt ?? new Date();

    const entry = this.domainProcessor.process({
      transaction,
      wallet,
      entryId,
      reference,
      reversalAlreadyProcessed,
      at,
    });

    return { wallet, entry, at };
  }

  private persistLedgerAndEvents(
    em: EntityManager,
    transaction: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
    context: WagerProcessingContext,
    at: Date,
  ): void {
    if (entry !== undefined) {
      em.persist(WalletLedgerEntryMapper.toRecord(entry));
    }

    const events: IntegrationEvent<unknown>[] = [
      this.createOutcomeEvent(transaction, this.eventContext(context, at)),
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
      em.persist(OutboxMessageMapper.toRecord(OutboxMessage.enqueue(event)));
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
