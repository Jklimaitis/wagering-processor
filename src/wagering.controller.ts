import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Res,
} from "@nestjs/common";
import { readString, readUuid } from "./application/input-validation";
import { parseWagerRequest } from "./application/parse-wager-request";
import { WagerTransactionStatus } from "./domain/wager-transaction";
import { DatabaseService } from "./infrastructure/database/database.service";
import {
  PostgresWagerProcessor,
  type PostgresWagerResult,
} from "./infrastructure/database/postgres-wager-processor";
import {
  PostgresFinancialReader,
  type WagerTransactionView,
} from "./infrastructure/database/postgres-financial-reader";

const HTTP_STATUS_BY_STATE: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.Failed]: 500,
};

@Controller("wagering/transactions")
export class WageringController {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
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
    @Res({ passthrough: true })
    response: { status(code: number): unknown },
  ): Promise<PostgresWagerResult> {
    const props = parseWagerRequest(body, idempotencyKey);

    const correlationId =
      correlationHeader === undefined
        ? crypto.randomUUID()
        : readString(correlationHeader, "x-correlation-id");

    const result = await new PostgresWagerProcessor(this.database.em).process(
      {
        ...props,
        id: crypto.randomUUID(),
      },
      undefined,
      { correlationId },
    );

    response.status(HTTP_STATUS_BY_STATE[result.status]);

    return result;
  }
}
