import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
  NotFoundError,
} from "@mikro-orm/core";
import {
  Catch,
  HttpException,
  Inject,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { InvalidInputError } from "./application/input-validation";
import { WalletAlreadyExistsError } from "./infrastructure/database/postgres-wallet-creator";
import { InvalidWagerTransactionError } from "./domain/wager-transaction";
import { IdempotencyConflictError } from "./infrastructure/database/postgres-wager-processor";

@Catch()
export class HttpExceptionFilter implements ExceptionFilter<unknown> {
  constructor(
    @Inject(HttpAdapterHost)
    private readonly adapterHost: HttpAdapterHost,
  ) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();

    const request = http.getRequest<{
      headers: Record<string, string | string[] | undefined>;
    }>();

    const suppliedCorrelationId = request.headers["x-correlation-id"];

    const correlationId =
      typeof suppliedCorrelationId === "string" &&
      suppliedCorrelationId.trim() !== ""
        ? suppliedCorrelationId
        : crypto.randomUUID();

    let statusCode = 500;
    let code = "INTERNAL_ERROR";
    let message = "Erro interno ao processar a requisição.";
    let field: string | undefined;

    const errorCode =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "";

    const transient =
      error instanceof ConnectionException ||
      error instanceof DeadlockException ||
      error instanceof LockWaitTimeoutException ||
      errorCode.startsWith("08") ||
      [
        "ECONNREFUSED",
        "ECONNRESET",
        "ETIMEDOUT",
        "40001",
        "57P01",
        "57P03",
      ].includes(errorCode);

    if (error instanceof InvalidInputError) {
      statusCode = 400;
      code = error.code;
      message = error.message;
      field = error.field;
    } else if (error instanceof InvalidWagerTransactionError) {
      statusCode = 400;
      code = "INVALID_OPERATION";
      message = error.message;
    } else if (
      error instanceof WalletAlreadyExistsError ||
      error instanceof IdempotencyConflictError
    ) {
      statusCode = 409;
      code = error.code;
      message = error.message;
    } else if (error instanceof NotFoundError) {
      statusCode = 404;
      code = "NOT_FOUND";
      message = "Recurso não encontrado.";
    } else if (error instanceof HttpException) {
      statusCode = error.getStatus();
      code =
        statusCode === 400
          ? "INVALID_INPUT"
          : statusCode === 404
            ? "NOT_FOUND"
            : `HTTP_${statusCode}`;

      if (statusCode < 500) {
        message = error.message;
      }
    } else if (
      error instanceof SyntaxError &&
      "type" in error &&
      error.type === "entity.parse.failed"
    ) {
      statusCode = 400;
      code = "INVALID_INPUT";
      message = "JSON inválido.";
    } else if (transient) {
      statusCode = 503;
      code = "INFRASTRUCTURE_UNAVAILABLE";
      message = "Infraestrutura temporariamente indisponível.";
    }

    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: statusCode >= 500 ? "error" : "warn",
        service: "api",
        event: "http_request_failed",
        correlationId,
        statusCode,
        code,
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
    );

    this.adapterHost.httpAdapter.reply(
      http.getResponse(),
      {
        statusCode,
        code,
        message,
        field,
        correlationId,
      },
      statusCode,
    );
  }
}
