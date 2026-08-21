import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Local mode keeps one SQLite file at the repo root. Without this, the file
 * would land wherever the process happened to be started from - a different
 * database for the server than for drizzle-kit.
 */
export function defaultLocalDatabaseUrl(): string {
  return pathToFileURL(resolve(REPO_ROOT, 'orbit.db')).href;
}

/**
 * Resolves a configured DATABASE_URL.
 *
 * A relative `file:./orbit.db` is resolved against the **repo root**, not the
 * working directory. Node would resolve it against whichever directory the
 * process started in, so the server (started from `apps/server`) and drizzle-kit
 * (started from `packages/db`) each silently opened their own empty database
 * while the real one sat unused at the root. A path written in a config file
 * means "relative to the project", not "relative to however you launched this".
 *
 * Remote URLs (libsql://, http://) and absolute file URLs pass through untouched.
 */
export function resolveDatabaseUrl(configured: string | undefined): string {
  if (!configured || configured.trim() === '') return defaultLocalDatabaseUrl();

  const url = configured.trim();
  if (!url.startsWith('file:')) return url;

  // file:/… and file:///… are already absolute.
  const path = url.slice('file:'.length).replace(/^\/\/\//, '/');
  if (isAbsolute(path) || /^\/[A-Za-z]:/.test(path)) return url;

  return pathToFileURL(resolve(REPO_ROOT, path)).href;
}
