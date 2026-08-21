import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

/**
 * Loads the repo-root .env.
 *
 * dotenv resolves a bare `.env` against the process working directory, and the
 * server starts from `apps/server` — so the root file was never read at all.
 * That failed quietly: every variable simply fell back to its default, and the
 * only symptom was an OAuth client id that appeared unset.
 *
 * Resolving from this module's own location instead makes it independent of
 * where the process was started. Real environment variables still win, so a
 * deployment that sets them directly (Render, CI, the Playwright config) is
 * unaffected.
 */
export function loadEnvFile(): void {
  const here = dirname(fileURLToPath(import.meta.url)); // apps/server/src/lib
  const repoRoot = resolve(here, '../../../..');
  const envPath = resolve(repoRoot, '.env');

  const result = existsSync(envPath) ? config({ path: envPath, quiet: true }) : config({ quiet: true });

  // A blank line in .env - `DATABASE_URL=` - parses to an empty string, which
  // is not undefined, so every `?? default` in the codebase would keep the
  // empty value and fail somewhere far away. Treat blank as absent.
  for (const [key, value] of Object.entries(result.parsed ?? {})) {
    if (value.trim() === '' && process.env[key]?.trim() === '') delete process.env[key];
  }
}
