import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Orbit mark, for the pages this server renders itself.
 *
 * Read from the same `favicon.svg` the application ships rather than drawn
 * again here. It was drawn again here - a circle and an ellipse, roughly the
 * right idea - and the result was a share page whose tab icon and whose own
 * heading were both visibly not the logo of the product that sent them. A
 * logo that disagrees with itself across two tabs reads as a phishing page.
 */

/** `apps/web/public/favicon.svg`, however the server was started. */
const SOURCE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'web',
  'public',
  'favicon.svg',
);

/**
 * What to draw if the file cannot be read.
 *
 * A deploy that ships the server without the web workspace is the case: the
 * share page still needs *something* in the tab, and the shape is at least the
 * right shape.
 */
const FALLBACK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<rect width="64" height="64" rx="14" fill="#151824"/>' +
  '<circle cx="32" cy="32" r="9.2" fill="#b3c4ff"/>' +
  '<ellipse cx="32" cy="32" rx="26" ry="10.5" fill="none" stroke="#6c8cff" ' +
  'stroke-width="2.6" transform="rotate(-22 32 32)"/>' +
  '</svg>';

let cached: string | undefined;

function source(): string {
  // Read once: a logo does not change between requests, and this is on the
  // path of every share page opened.
  cached ??= (() => {
    try {
      return readFileSync(SOURCE, 'utf8');
    } catch {
      return FALLBACK;
    }
  })();

  return cached;
}

/** The mark as a data URI, for `<link rel="icon">`. */
export function brandFavicon(): string {
  return `data:image/svg+xml,${encodeURIComponent(source().replace(/\n\s*/g, ' '))}`;
}

/**
 * The mark inline, at a given size, for a heading.
 *
 * The dark rounded square goes: it exists so the icon has an edge in a browser
 * tab, and on a page it would put the logo in a little box of its own that
 * nothing else on the page has.
 */
export function brandMark(size = 26): string {
  const svg = source()
    .replace(/<rect[^>]*fill="#151824"[^>]*\/>/, '')
    .replace('<svg', `<svg width="${size}" height="${size}" aria-hidden="true"`);

  return svg.replace(/\n\s*/g, ' ');
}
