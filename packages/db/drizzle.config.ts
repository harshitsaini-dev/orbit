import { defineConfig } from 'drizzle-kit';
import { resolveDatabaseUrl } from './src/paths.js';

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'turso',
  dbCredentials: {
    url: resolveDatabaseUrl(process.env.DATABASE_URL),
    authToken: process.env.DATABASE_AUTH_TOKEN,
  },
});
