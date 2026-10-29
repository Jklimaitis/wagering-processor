import { MikroORM } from '@mikro-orm/postgresql';
import config from './mikro-orm.config';

async function main(): Promise<void> {
  const orm = await MikroORM.init(config);

  try {
    await orm.connect();

    const result = await orm.checkConnection();

    if (!result.ok) {
      throw new Error(result.reason);
    }

    console.log('PostgreSQL conectado via MikroORM.');
  } finally {
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  console.error(
    'Falha na conexão:',
    error instanceof Error ? error.message : String(error),
  );

  process.exitCode = 1;
});