import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { resolveDatabaseUrl } from './paths.js';
import * as schema from './schema.js';

export type Database = ReturnType<typeof createDatabase>;

/**
 * A local SQLite file defaults to rollback-journal mode, which takes an
 * exclusive lock for every write - concurrent requests then fail outright with
 * SQLITE_BUSY. WAL lets readers run alongside a writer, and busy_timeout makes
 * a contended write wait instead of erroring. Turso already behaves this way,
 * so this only applies to file: URLs.
 */
export async function applySqlitePragmas(client: Client, url: string): Promise<void> {
  if (!url.startsWith('file:')) return;
  await client.executeMultiple('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
}

export function createDatabase(
  url: string = resolveDatabaseUrl(process.env.DATABASE_URL),
  authToken: string | undefined = process.env.DATABASE_AUTH_TOKEN || undefined,
) {
  const client: Client = createClient({ url, authToken });

  // The libSQL client serialises statements on its connection, so the pragmas
  // land before any query issued afterwards.
  void applySqlitePragmas(client, url);

  return drizzle(client, { schema });
}
