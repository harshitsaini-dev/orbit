import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './env.js';

/**
 * Where the share page's viewer comes from.
 *
 * The share page is served by the API and the workspace is a separate bundle,
 * so the viewer cannot simply be imported. It is built as its own entry into
 * `apps/server/public/share` and served from `/s/asset` - same origin as the
 * bytes, which is what lets the page stream a file without the provider's URL
 * ever reaching the browser.
 *
 * Three states, and the page has to cope with all of them:
 *
 * - built, which is production and anyone who has run a build;
 * - not built but developing, where Vite serves the entry from its own port
 *   and the page loads it from there, so the viewer can be worked on live;
 * - not built at all, where the page keeps its server-rendered fallback and a
 *   visitor loses the richer formats rather than the file.
 */

/** `apps/server/public/share`, however the server was started. */
const BUNDLE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'share');

export const SHARE_ASSET_DIR = BUNDLE_DIR;
export const SHARE_ASSET_PATH = '/s/asset';

export interface ShareBundle {
  /**
   * An inline module the page must run before the scripts, if any. Only
   * development has one: React Fast Refresh installs a hook that the entry
   * refuses to start without.
   */
  preamble?: string;
  /** Module scripts the page must load, in order. */
  scripts: string[];
  /** Stylesheets to link, if the build emitted any. */
  styles: string[];
  /**
   * Origins the policy has to allow beyond this one. Empty in production; the
   * Vite dev server in development.
   */
  origins: string[];
}

interface ViteManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

let cached: ShareBundle | null | undefined;

function readManifest(): ShareBundle | null {
  try {
    const raw = readFileSync(join(BUNDLE_DIR, '.vite', 'manifest.json'), 'utf8');
    const manifest = JSON.parse(raw) as Record<string, ViteManifestEntry>;

    const entry = Object.values(manifest).find((item) => item.isEntry);
    if (!entry) return null;

    return {
      scripts: [`${SHARE_ASSET_PATH}/${entry.file}`],
      styles: (entry.css ?? []).map((file) => `${SHARE_ASSET_PATH}/${file}`),
      origins: [],
    };
  } catch {
    return null;
  }
}

/**
 * Vite normally rewrites the HTML it serves, and its React plugin puts a Fast
 * Refresh preamble in there. This page is not Vite's HTML, so the preamble has
 * to be written out - the entry throws with "can't detect preamble" without it,
 * and the viewer never mounts.
 */
function fromDevServer(): ShareBundle {
  const base = env.APP_URL.replace(/\/$/, '');

  return {
    preamble: [
      `import RefreshRuntime from '${base}/@react-refresh';`,
      'RefreshRuntime.injectIntoGlobalHook(window);',
      'window.$RefreshReg$ = () => {};',
      'window.$RefreshSig$ = () => (type) => type;',
      'window.__vite_plugin_react_preamble_installed__ = true;',
    ].join(' '),
    scripts: [`${base}/@vite/client`, `${base}/src/share.tsx`],
    styles: [],
    origins: [base, base.replace(/^http/, 'ws')],
  };
}

export function shareBundle(): ShareBundle | null {
  /*
   * Resolved once: a build does not appear halfway through a run, and reading
   * the manifest per request would be a file read on every share opened.
   *
   * Development asks Vite first even when a build exists. The alternative -
   * preferring what is on disk - shows whatever was built last and gives no
   * sign that it is stale, which is the worst way to work on a viewer. If Vite
   * is not running the script simply does not load, and the page keeps the
   * fallback the server already rendered.
   */
  if (cached === undefined) {
    cached = env.NODE_ENV === 'production' ? readManifest() : fromDevServer();
  }

  return cached;
}
