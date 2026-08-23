import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Absolute, so the server and the migration step cannot disagree about where it lives. */
export const E2E_DB_PATH = resolve(REPO_ROOT, 'orbit-e2e.db');
export const E2E_DB_URL = pathToFileURL(E2E_DB_PATH).href;

/**
 * Where the two servers run during a test run.
 *
 * Shared with `playwright.config.ts` rather than repeated in it: a spec that
 * needs the API's own origin - the OAuth authorise endpoint is one, since it is
 * not on the app's origin - would otherwise hardcode a port and quietly hit the
 * development server instead when the two disagree.
 */
export const E2E_WEB_PORT = 5174;
export const E2E_API_PORT = 8788;
export const E2E_WEB_URL = `http://localhost:${E2E_WEB_PORT}`;
export const E2E_API_URL = `http://localhost:${E2E_API_PORT}`;
