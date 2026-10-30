import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { HealthController } from "./health.controller";
import { HttpExceptionFilter } from "./http-exception.filter";
import { DatabaseService } from "./infrastructure/database/database.service";
import {
  createSqsClient,
  getSqsEventsQueueName,
  getSqsWagerQueueNames,
} from "./infrastructure/messaging/sqs-client";
import { MetricsController } from "./metrics.controller";
import { MetricsService } from "./metrics.service";
import { ProviderTransactionsController } from "./provider-transactions.controller";
import { ReadinessService } from "./readiness.service";
import { WageringController } from "./wagering.controller";
import { WalletsController } from "./wallets.controller";

@Module({
  controllers: [
    HealthController,
    WalletsController,
    WageringController,
    ProviderTransactionsController,
    MetricsController,
  ],
  providers: [
    MetricsService,
    {
      provide: DatabaseService,
      useFactory: () => new DatabaseService(),
    },
    {
      provide: ReadinessService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) => {
        const { queueName, dlqName } = getSqsWagerQueueNames();

        return new ReadinessService(database, createSqsClient(), [
          queueName,
          dlqName,
          getSqsEventsQueueName(),
        ]);
      },
    },
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class AppModule {}
