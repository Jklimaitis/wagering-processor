import { Body, Controller, Headers, Inject, Post, Res } from "@nestjs/common";
import { readString } from "./application/input-validation";
import { parseWagerRequest } from "./application/parse-wager-request";
import { WagerTransactionStatus } from "./domain/wager-transaction";
import { DatabaseService } from "./infrastructure/database/database.service";
import {
  PostgresWagerProcessor,
  type PostgresWagerResult,
} from "./infrastructure/database/postgres-wager-processor";

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
