import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { defaultLocalDatabaseUrl } from './paths.js';
import * as schema from './schema.js';

export type Database = ReturnType<typeof createDatabase>;

/**
 * One code path for both app modes:
 *   local  -> DATABASE_URL=file:./orbit.db
 *   hosted -> DATABASE_URL=libsql://<db>.turso.io + DATABASE_AUTH_TOKEN
 */
export function createDatabase(
  url: string = process.env.DATABASE_URL ?? defaultLocalDatabaseUrl(),
  authToken: string | undefined = process.env.DATABASE_AUTH_TOKEN,
) {
  const client: Client = createClient({ url, authToken });
  return drizzle(client, { schema });
}
