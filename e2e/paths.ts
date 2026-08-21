import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Absolute, so the server and the migration step cannot disagree about where it lives. */
export const E2E_DB_PATH = resolve(REPO_ROOT, 'orbit-e2e.db');
export const E2E_DB_URL = pathToFileURL(E2E_DB_PATH).href;
