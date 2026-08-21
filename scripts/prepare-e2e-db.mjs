/**
 * Rebuilds the E2E database from the real migrations.
 *
 * This runs as part of the Playwright `webServer` command rather than from
 * `globalSetup`, because Playwright starts the web servers *before* global
 * setup. Doing it in global setup meant the server booted against a database
 * that was about to be deleted out from under its open connection.
 */
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = resolve(repoRoot, 'orbit-e2e.db');
const dbUrl = pathToFileURL(dbPath).href;

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}

const client = createClient({ url: dbUrl });

// WAL is persisted in the file, so every later connection inherits it.
await client.executeMultiple('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

const migrationsDir = join(repoRoot, 'packages', 'db', 'migrations');
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

client.close();
console.log(`e2e database rebuilt from ${files.length} migration(s)`);
