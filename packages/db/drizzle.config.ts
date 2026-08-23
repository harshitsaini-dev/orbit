import { resolve } from 'node:path';
import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';
import { REPO_ROOT, resolveDatabaseUrl } from './src/paths.js';

/*
 * The repo root's .env, explicitly, and this line is load-bearing.
 *
 * drizzle-kit reads a .env from its own working directory, which is
 * `packages/db` - and there is no .env there. So `process.env.DATABASE_URL`
 * came back undefined, `resolveDatabaseUrl` did what it is supposed to do with
 * nothing, and every `npm run db:migrate` quietly migrated the *local*
 * `orbit.db` instead of the database it was aimed at.
 *
 * Nothing said so. drizzle-kit printed "migrations applied successfully"
 * either way, which is the worst possible way to be wrong about a schema: the
 * deploy looks done and the first query against the new column is a 500.
 *
 * Caught by checking the production schema afterwards rather than by trusting
 * that message - which is now the documented step.
 */
config({ path: resolve(REPO_ROOT, '.env') });

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'turso',
  dbCredentials: {
    url: resolveDatabaseUrl(process.env.DATABASE_URL),
    authToken: process.env.DATABASE_AUTH_TOKEN,
  },
});
