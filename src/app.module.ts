import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { HealthController } from "./health.controller";
import { HttpExceptionFilter } from "./http-exception.filter";
import { DatabaseService } from "./infrastructure/database/database.service";
import { WalletsController } from "./wallets.controller";
import { WageringController } from "./wagering.controller";
import { ProviderTransactionsController } from "./provider-transactions.controller";

@Module({
  controllers: [
    HealthController,
    WalletsController,
    WageringController,
    ProviderTransactionsController,
  ],
  providers: [
    {
      provide: DatabaseService,
      useFactory: () => new DatabaseService(),
    },
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class AppModule {}
