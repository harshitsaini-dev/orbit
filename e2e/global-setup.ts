import { rmSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_DB_PATH, E2E_DB_URL, REPO_ROOT } from './paths.js';

/**
 * Rebuilds the E2E database from the real migrations before every run, so the
 * suite never depends on leftover state from a previous run.
 */
export default async function globalSetup(): Promise<void> {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    rmSync(`${E2E_DB_PATH}${suffix}`, { force: true });
  }

  const client = createClient({ url: E2E_DB_URL });
  // WAL is persisted in the file, so every later connection inherits it.
  await client.executeMultiple('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const migrationsDir = join(REPO_ROOT, 'packages', 'db', 'migrations');

  for (const file of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.executeMultiple(trimmed);
    }
  }

  client.close();
}
