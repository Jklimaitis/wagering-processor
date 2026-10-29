import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WalletSchema } from './wallet-record';

const clientUrl = process.env.DATABASE_URL;

if (!clientUrl) {
  throw new Error('Defina DATABASE_URL no arquivo .env.');
}

export default defineConfig({
  clientUrl,
  schema: 'public',

  entities: [WalletSchema],

  extensions: [Migrator],

  migrations: {
    path: './src/infrastructure/database/migrations',
    glob: 'Migration*.ts',
    emit: 'ts',
    transactional: true,
    allOrNothing: true,
  },

  debug: false,
});