import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { readString, readUuid } from "./application/input-validation";
import { parseWagerRequest } from "./application/parse-wager-request";
import { WagerTransactionStatus } from "./domain/wager-transaction";
import type { HttpRequestContext } from "./http-request-context";
import { DatabaseService } from "./infrastructure/database/database.service";
import {
  PostgresWagerProcessor,
  type PostgresWagerResult,
} from "./infrastructure/database/postgres-wager-processor";
import {
  PostgresFinancialReader,
  type WagerTransactionView,
} from "./infrastructure/database/postgres-financial-reader";
import { MetricsService } from "./metrics.service";
import { ProviderIdentityGuard } from "./provider-identity.guard";

const HTTP_STATUS_BY_STATE: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.Failed]: 500,
};

@Controller("wagering/transactions")
@UseGuards(ProviderIdentityGuard)
export class WageringController {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(MetricsService)
    private readonly metrics: MetricsService,
  ) {}

  @Get(":transactionId")
  async findOne(
    @Param("transactionId") transactionId: unknown,
  ): Promise<WagerTransactionView> {
    return new PostgresFinancialReader(this.database.em).findTransactionById(
      readUuid(transactionId, "transactionId"),
    );
  }

  @Post()
  async process(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: unknown,
    @Headers("x-correlation-id") correlationHeader: unknown,
    @Req() request: HttpRequestContext,
    @Res({ passthrough: true })
    response: {
      status(code: number): unknown;
      setHeader(name: string, value: string): unknown;
    },
  ): Promise<PostgresWagerResult> {
    const finish = this.metrics.startProcessing("http");

    try {
      const correlationId =
        correlationHeader === undefined
          ? crypto.randomUUID()
          : readString(correlationHeader, "x-correlation-id");

      request.correlationId = correlationId;
      response.setHeader("x-correlation-id", correlationId);

      const props = parseWagerRequest(body, idempotencyKey);

      request.walletId = props.walletId;
      request.providerId = props.providerId;

      const result = await new PostgresWagerProcessor(this.database.em).process(
        {
          ...props,
          id: crypto.randomUUID(),
        },
        undefined,
        { correlationId },
      );

      request.transactionId = result.transactionId;
      this.metrics.recordWagerResult("http", result);

      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "info",
          service: "api",
          event: "wager_http_completed",
          correlationId,
          messageId: null,
          transactionId: result.transactionId,
          walletId: props.walletId,
          providerId: props.providerId,
          status: result.status,
          failureCode: result.failureCode,
          idempotentReplay: result.idempotentReplay,
        }),
      );

      response.status(HTTP_STATUS_BY_STATE[result.status]);

      return result;
    } finally {
      finish();
    }
  }
}
