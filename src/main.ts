import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const input = process.env.PORT ?? "3000";
  if (!/^[1-9][0-9]{0,4}$/.test(input) || Number(input) > 65535) {
    throw new Error("PORT deve estar entre 1 e 65535.");
  }
  const app = await NestFactory.create(AppModule, { logger: false });

  app.enableShutdownHooks();

  await app.listen(Number(input), "0.0.0.0");
  console.log(JSON.stringify({ timestamp: new Date().toISOString(),
    level: "info", service: "api", event: "api_ready", port: Number(input) }));
}

bootstrap().catch((error: unknown) => {
  console.error(JSON.stringify({ timestamp: new Date().toISOString(),
    level: "error", service: "api", event: "api_start_failed",
    errorName: error instanceof Error ? error.name : "UnknownError" }));
  process.exitCode = 1;
});
