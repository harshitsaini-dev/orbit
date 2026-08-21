import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Local mode keeps one SQLite file at the repo root. Without this, the file
 * would land wherever the process happened to be started from - a different
 * database for the server than for drizzle-kit.
 */
export function defaultLocalDatabaseUrl(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // packages/db/src
  const repoRoot = resolve(here, '../../..');
  return pathToFileURL(resolve(repoRoot, 'orbit.db')).href;
}
