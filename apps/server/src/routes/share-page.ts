import type { PublicShare } from '../services/shares.js';

/**
 * The page a share link opens.
 *
 * Rendered here rather than by the React app, for one reason: the bytes are
 * served from this origin, and a page served from another one could not stream
 * them without either a cross-origin dance or a redirect that leaks where the
 * file really is. Serving both from the same place is what keeps the provider
 * invisible.
 *
 * It runs no JavaScript at all. Not minimalism - the content-security-policy
 * can then say `default-src 'none'` and mean it, which matters on a page whose
 * whole job is to render a file a stranger sent you.
 */

export type SharePageInput =
  | { kind: 'missing' }
  | { kind: 'expired' }
  | { kind: 'locked'; shortId: string; wrong?: boolean }
  | { kind: 'file'; shortId: string; share: PublicShare };

/** Everything interpolated goes through this; a file name is not trusted markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

type Preview = 'image' | 'video' | 'audio' | 'pdf' | 'none';

/**
 * What the page can show inline without scripts.
 *
 * Deliberately narrower than the workspace's own preview, which has viewers
 * behind it. Here there is only what the browser renders natively, and SVG is
 * excluded: in an `<img>` it would be safe, but a share page is the one place
 * a hostile file is most likely to arrive.
 */
function previewOf(mimeType: string, name: string): Preview {
  const mime = mimeType.toLowerCase();
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();

  if (mime === 'image/svg+xml' || extension === 'svg') return 'none';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf' || extension === 'pdf') return 'pdf';

  if (mime === 'application/octet-stream' || mime === '') {
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'].includes(extension)) return 'image';
    if (['mp4', 'webm', 'mov', 'm4v'].includes(extension)) return 'video';
    if (['mp3', 'wav', 'flac', 'ogg', 'm4a'].includes(extension)) return 'audio';
  }

  return 'none';
}

const STYLES = `
  :root {
    color-scheme: dark;
    --bg: #12151f;
    --surface: #1a1f2e;
    --text: #eef1f6;
    --muted: #98a1b8;
    --accent: #6c8cff;
    --border: rgba(238, 241, 246, 0.1);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: 1.5rem;
    background: var(--bg);
    color: var(--text);
    font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main {
    width: min(760px, 100%);
    display: grid;
    gap: 1rem;
  }
  .card {
    background: var(--surface);
    border-radius: 18px;
    box-shadow: 0 18px 40px rgba(0, 0, 0, 0.35);
    padding: clamp(1.25rem, 4vw, 2rem);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 9px;
    font-weight: 700;
    letter-spacing: -0.03em;
    font-size: 19px;
  }
  .brand svg { display: block; }
  h1 {
    margin: 0.35rem 0 0.2rem;
    font-size: clamp(1.15rem, 3.5vw, 1.5rem);
    letter-spacing: -0.02em;
    overflow-wrap: anywhere;
  }
  .meta { color: var(--muted); font-size: 14px; margin: 0; }
  .stage {
    margin-top: 1rem;
    display: grid;
    place-items: center;
    background: #0d1018;
    border-radius: 12px;
    overflow: hidden;
  }
  .stage img, .stage video { max-width: 100%; max-height: 70dvh; display: block; }
  .stage audio { width: 100%; padding: 1.5rem; }
  .stage object { width: 100%; height: 70dvh; border: 0; }
  .actions { display: flex; gap: 0.6rem; flex-wrap: wrap; margin-top: 1.1rem; }
  a.button, button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 0.6rem 1.3rem;
    border: 0;
    border-radius: 999px;
    background: var(--accent);
    color: #fff;
    font: inherit;
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
  }
  a.button.secondary, .qr-open {
    background: transparent;
    color: var(--text);
    box-shadow: inset 0 0 0 1px var(--border);
  }
  label { display: grid; gap: 6px; font-size: 14px; }
  input[type="password"] {
    padding: 0.65rem 0.9rem;
    border: 0;
    border-radius: 10px;
    background: #0d1018;
    color: var(--text);
    font: inherit;
  }
  .error { color: #e05252; font-size: 14px; margin: 0; }
  footer { color: var(--muted); font-size: 12.5px; text-align: center; }
  .qr { display: grid; justify-items: center; gap: 0.6rem; }
  .qr img { width: 168px; height: 168px; background: #fff; border-radius: 10px; padding: 8px; }
`;

const MARK = `<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><circle cx="16" cy="16" r="6" fill="#6c8cff"/><ellipse cx="16" cy="16" rx="14" ry="5.5" fill="none" stroke="#6c8cff" stroke-width="1.6" opacity="0.7" transform="rotate(-22 16 16)"/></svg>`;

/**
 * The same mark again, as a data URI for the tab.
 *
 * Inline rather than a link to /favicon.svg: this page is served by the API,
 * which serves no static files, so a link would 404 and leave a share looking
 * like it came from nowhere. A data URI has no such dependency and costs a few
 * hundred bytes on a page that is already sending an image.
 */
const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    '<circle cx="16" cy="16" r="6" fill="#6c8cff"/>' +
    '<ellipse cx="16" cy="16" rx="14" ry="5.5" fill="none" stroke="#6c8cff" stroke-width="1.6" opacity="0.7" transform="rotate(-22 16 16)"/>' +
    '</svg>',
)}`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="${FAVICON}" type="image/svg+xml">
<style>${STYLES}</style>
</head>
<body>
<main>
  <div class="card">
    <span class="brand">${MARK} Orbit</span>
    ${body}
  </div>
  <footer>Shared through Orbit. The file stays in its owner's own cloud storage.</footer>
</main>
</body>
</html>`;
}

export function sharePage(input: SharePageInput): string {
  if (input.kind === 'missing') {
    return shell(
      'Link not found',
      `<h1>This link does not work</h1>
       <p class="meta">It may have been revoked by whoever shared it, or mistyped. There is nothing here to see.</p>`,
    );
  }

  if (input.kind === 'expired') {
    return shell(
      'Link expired',
      `<h1>This link has expired</h1>
       <p class="meta">Whoever shared it set an expiry date, and it has passed. Ask them for a new link.</p>`,
    );
  }

  if (input.kind === 'locked') {
    return shell(
      'Password needed',
      `<h1>This file is password protected</h1>
       <p class="meta">Enter the password whoever shared it gave you.</p>
       ${input.wrong ? '<p class="error" role="alert">That password did not work. Try again.</p>' : ''}
       <form method="post" action="/s/${escapeHtml(input.shortId)}/unlock" style="display:grid;gap:0.8rem;margin-top:1rem">
         <label>Password
           <input type="password" name="password" autocomplete="off" autofocus required>
         </label>
         <div class="actions"><button type="submit">Unlock</button></div>
       </form>`,
    );
  }

  const { share, shortId } = input;
  const src = `/s/${escapeHtml(shortId)}/content`;
  const preview = previewOf(share.mimeType, share.name);
  const name = escapeHtml(share.name);

  const stage =
    preview === 'image'
      ? `<div class="stage"><img src="${src}" alt="${name}"></div>`
      : preview === 'video'
        ? // preload="metadata": the duration and first frame, not the whole
          // file, so opening a link to a 4GB video costs almost nothing.
          `<div class="stage"><video src="${src}" controls preload="metadata"></video></div>`
        : preview === 'audio'
          ? `<div class="stage"><audio src="${src}" controls preload="metadata"></audio></div>`
          : preview === 'pdf'
            ? `<div class="stage"><object data="${src}" type="application/pdf"><p class="meta" style="padding:1.5rem">Your browser will not display this PDF. Download it instead.</p></object></div>`
            : '';

  const download =
    share.permission === 'download'
      ? `<a class="button" href="${src}?download" download="${name}">Download</a>`
      : '';

  return shell(
    share.name,
    `<h1>${name}</h1>
     <p class="meta">${formatBytes(share.sizeBytes)}${
       share.expiresAt
         ? ` · link expires ${escapeHtml(new Date(share.expiresAt).toISOString().slice(0, 10))}`
         : ''
     }</p>
     ${stage}
     <div class="actions">
       ${download}
       ${preview === 'none' && share.permission !== 'download' ? '<p class="meta">The owner shared this to view only, and it cannot be shown in a browser.</p>' : ''}
     </div>
     <div class="qr" style="margin-top:1.5rem">
       <img src="/s/${escapeHtml(shortId)}/qr" alt="QR code for this link" width="168" height="168">
       <span class="meta">Scan to open on a phone</span>
     </div>`,
  );
}
