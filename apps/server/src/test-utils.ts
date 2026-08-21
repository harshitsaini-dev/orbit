import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import * as schema from '@orbit/db/schema';
import { drizzle } from 'drizzle-orm/libsql';
import { setDatabase } from './lib/db.js';

/**
 * A throwaway in-memory database with the real migrations applied, so tests run
 * against the same schema production does without touching orbit.db.
 */

/**
 * The client from the previous call, closed before the next one opens.
 *
 * libsql is a native module, and a client holds a native handle. Called from a
 * beforeEach, this used to leave one open per test - a few dozen per file - and
 * the process would occasionally die on exit with an access violation while
 * they were all finalised at once. Every subtest had passed by then, so it
 * surfaced as a whole test file failing for no stated reason, and only under
 * the memory pressure of the full suite running in parallel.
 */
let current: Client | null = null;

/** Read once: the migrations do not change between tests in a run. */
let migrations: string[] | null = null;

function loadMigrations(): string[] {
  if (migrations) return migrations;

  const here = dirname(fileURLToPath(import.meta.url));
  const directory = resolve(here, '../../../packages/db/migrations');

  migrations = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => readFileSync(join(directory, name), 'utf8'));

  return migrations;
}

export async function useTestDatabase(): Promise<void> {
  current?.close();

  const client = createClient({ url: ':memory:' });
  current = client;

  for (const sql of loadMigrations()) {
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.executeMultiple(trimmed);
    }
  }

  setDatabase(drizzle(client, { schema }));
}

// The last one has no successor to close it, so the exit handler does.
process.on('exit', () => {
  current?.close();
  current = null;
});
