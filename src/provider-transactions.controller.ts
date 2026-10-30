import { Controller, Get, Inject, Param, UseGuards } from "@nestjs/common";
import { ProviderIdentityGuard } from "./provider-identity.guard";
import { readString } from "./application/input-validation";
import { DatabaseService } from "./infrastructure/database/database.service";
import {
  PostgresFinancialReader,
  type WagerTransactionView,
} from "./infrastructure/database/postgres-financial-reader";

@Controller("providers")
@UseGuards(ProviderIdentityGuard)
export class ProviderTransactionsController {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  @Get(":providerId/wagering/transactions/:externalTransactionId")
  async findOne(
    @Param("providerId") providerId: unknown,
    @Param("externalTransactionId") externalTransactionId: unknown,
  ): Promise<WagerTransactionView> {
    return new PostgresFinancialReader(
      this.database.em,
    ).findTransactionByProvider(
      readString(providerId, "providerId"),
      readString(externalTransactionId, "externalTransactionId"),
    );
  }
}
