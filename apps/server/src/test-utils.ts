import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import * as schema from '@orbit/db/schema';
import { drizzle } from 'drizzle-orm/libsql';
import { setDatabase } from './lib/db.js';

/**
 * A throwaway in-memory database with the real migrations applied, so tests run
 * against the same schema production does without touching orbit.db.
 */
export async function useTestDatabase(): Promise<void> {
  const client = createClient({ url: ':memory:' });
  const database = drizzle(client, { schema });

  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = resolve(here, '../../../packages/db/migrations');

  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.executeMultiple(trimmed);
    }
  }

  setDatabase(database);
}
