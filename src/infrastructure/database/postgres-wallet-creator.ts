import {
  IsolationLevel,
  UniqueConstraintViolationException,
} from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { Money, type MoneyProps } from "../../domain/money";
import { Wallet } from "../../domain/wallet";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../../domain/wallet-ledger-entry";
import {
  WagerTransaction,
  WagerTransactionKind,
} from "../../domain/wager-transaction";
import { WagerTransactionProcessed } from "../../domain/wager-transaction-events";
import { WalletBalanceChanged } from "../../domain/wallet-balance-changed";
import { OutboxMessage } from "../../domain/outbox-message";
import { hashWagerPayload } from "../idempotency/wager-payload-hash";
import { WalletMapper } from "./wallet-mapper";
import { WagerTransactionMapper } from "./wager-transaction-mapper";
import { WalletLedgerEntryMapper } from "./wallet-ledger-entry-mapper";
import { OutboxMessageMapper } from "./outbox-message-mapper";

export interface CreateWalletProps {
  playerId: string;
  initialBalance: Money;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export class WalletAlreadyExistsError extends Error {
  readonly code = "WALLET_ALREADY_EXISTS";

  constructor() {
    super("Já existe uma wallet para este jogador e moeda.");
    this.name = "WalletAlreadyExistsError";
  }
}

export class PostgresWalletCreator {
  constructor(private readonly em: EntityManager) {}

  async create(
    props: CreateWalletProps,
    context: {
      correlationId: string;
      causationId?: string;
    } = { correlationId: crypto.randomUUID() },
  ): Promise<WalletView> {
    const at = new Date();

    const wallet = Wallet.open(
      {
        id: crypto.randomUUID(),
        playerId: props.playerId,
        initialBalance: props.initialBalance,
      },
      at,
    );

    try {
      return await this.em.fork().transactional(
        async (em) => {
          em.persist(WalletMapper.toRecord(wallet));
          await em.flush();

          if (wallet.balance.isPositive()) {
            const openingId = crypto.randomUUID();

            const openingProps = {
              id: openingId,
              providerId: "__internal__",
              externalTransactionId: openingId,
              idempotencyKey: `opening:${wallet.id}`,
              walletId: wallet.id,
              playerId: wallet.playerId,
              roundId: "wallet-opening",
              gameId: "wallet-opening",
              kind: WagerTransactionKind.Opening,
              money: wallet.balance,
            };

            const opening = WagerTransaction.create(
              {
                ...openingProps,
                payloadHash: hashWagerPayload(openingProps),
              },
              at,
            );

            opening.markProcessed(undefined, at);

            const openingRecord = WagerTransactionMapper.toRecord(
              opening,
              wallet.balance,
            );

            openingRecord.correlationId = context.correlationId;
            openingRecord.causationId = context.causationId ?? null;

            em.persist(openingRecord);
            await em.flush();

            const entry = WalletLedgerEntry.create({
              id: crypto.randomUUID(),
              walletId: wallet.id,
              transactionId: opening.id,
              direction: LedgerDirection.Credit,
              money: wallet.balance,
              balanceBefore: Money.zero(wallet.currency),
              balanceAfter: wallet.balance,
              createdAt: at,
            });

            em.persist(WalletLedgerEntryMapper.toRecord(entry));

            const eventContext = {
              correlationId: context.correlationId,
              causationId: context.causationId,
              occurredAt: at,
            };

            const events = [
              WagerTransactionProcessed.from(opening, {
                ...eventContext,
                eventId: crypto.randomUUID(),
              }),
              WalletBalanceChanged.from(wallet, entry, {
                ...eventContext,
                eventId: crypto.randomUUID(),
              }),
            ];

            for (const event of events) {
              em.persist(
                OutboxMessageMapper.toRecord(
                  OutboxMessage.enqueue<unknown>(event),
                ),
              );
            }
          }

          return {
            id: wallet.id,
            playerId: wallet.playerId,
            balance: wallet.balance.toJSON(),
            version: wallet.version,
          };
        },
        { isolationLevel: IsolationLevel.READ_COMMITTED },
      );
    } catch (error: unknown) {
      if (
        error instanceof UniqueConstraintViolationException &&
        "constraint" in error &&
        error.constraint === "wallets_player_currency_unique"
      ) {
        throw new WalletAlreadyExistsError();
      }

      throw error;
    }
  }
}
