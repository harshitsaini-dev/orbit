import { defineConfig } from 'drizzle-kit';
import { defaultLocalDatabaseUrl } from './src/paths.js';

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'turso',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? defaultLocalDatabaseUrl(),
    authToken: process.env.DATABASE_AUTH_TOKEN,
  },
});
