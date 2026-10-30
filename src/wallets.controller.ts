import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import {
  InvalidInputError,
  readObject,
  readString,
  readUuid,
} from "./application/input-validation";
import { InvalidMoneyError, Money } from "./domain/money";
import { DatabaseService } from "./infrastructure/database/database.service";
import {
  PostgresWalletCreator,
  type WalletView,
} from "./infrastructure/database/postgres-wallet-creator";
import {
  PostgresFinancialReader,
  type LedgerPageView,
} from "./infrastructure/database/postgres-financial-reader";
import { parseLedgerPage } from "./application/ledger-pagination";

@Controller("wallets")
export class WalletsController {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  @Get(":walletId")
  async findOne(@Param("walletId") walletId: unknown): Promise<WalletView> {
    return new PostgresFinancialReader(this.database.em).findWallet(
      readUuid(walletId, "walletId"),
    );
  }

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId") walletId: unknown,
    @Query("cursor") cursor: unknown,
    @Query("limit") limit: unknown,
  ): Promise<LedgerPageView> {
    return new PostgresFinancialReader(this.database.em).listLedger(
      parseLedgerPage(walletId, cursor, limit),
    );
  }
  
  @Post()
  async create(
    @Body() body: unknown,
    @Headers("x-correlation-id") correlationHeader: unknown,
  ): Promise<WalletView> {
    const input = readObject(body, "body");
    const playerId = readUuid(input.playerId, "playerId");

    const balanceInput = readObject(input.initialBalance, "initialBalance");

    let initialBalance: Money;

    try {
      initialBalance = Money.from({
        amount: readString(balanceInput.amount, "initialBalance.amount"),
        currency: readString(balanceInput.currency, "initialBalance.currency"),
      });
    } catch (error: unknown) {
      if (error instanceof InvalidMoneyError) {
        throw new InvalidInputError("initialBalance");
      }

      throw error;
    }

    const correlationId =
      correlationHeader === undefined
        ? crypto.randomUUID()
        : readString(correlationHeader, "x-correlation-id");

    return new PostgresWalletCreator(this.database.em).create(
      { playerId, initialBalance },
      { correlationId },
    );
  }
}
