import { shareBundle } from '../lib/share-bundle.js';
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
 * What it renders on its own is what the browser renders natively: an image, a
 * video, a PDF. Over that it mounts the workspace's own viewer, built as its
 * own bundle and served from this origin, so a shared spreadsheet, archive or
 * document opens the way its owner sees it rather than as a download button.
 *
 * The order matters. The page works with no JavaScript at all, and the viewer
 * replaces what is already there; if the bundle is missing or blocked, a
 * visitor loses the richer formats rather than the file.
 */

export type SharePageInput =
  | { kind: 'missing' }
  | { kind: 'expired' }
  | { kind: 'locked'; shortId: string; wrong?: boolean }
  | { kind: 'file'; shortId: string; share: PublicShare; nonce: string };

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
  .stage[data-zoom] { position: relative; touch-action: none; }
  .stage[data-zoom] img {
    transform-origin: center;
    transition: transform 90ms ease-out;
    cursor: zoom-in;
    user-select: none;
    -webkit-user-drag: none;
  }
  /* Grab, not zoom-in, once there is somewhere to drag to. */
  .stage[data-zoom][data-zoomed] img { cursor: grab; transition: none; }
  .stage[data-zoom][data-zoomed] img:active { cursor: grabbing; }
  /* Fullscreen paints its own black behind the image, so the stage has to
     fill it rather than sit in the middle at its old size. */
  .stage[data-zoom]:fullscreen { background: #05070c; }
  .stage[data-zoom]:fullscreen img { max-height: 100dvh; max-width: 100vw; }
  .zoom-controls {
    position: absolute;
    right: 10px;
    bottom: 10px;
    display: flex;
    gap: 4px;
    opacity: 0.85;
  }
  .zoom-controls button {
    min-width: 34px;
    padding: 0.25rem 0.5rem;
    font-size: 13px;
    line-height: 1.4;
  }
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

/**
 * `head` and `tail` carry the viewer bundle, when there is one.
 *
 * Everything the server renders lives inside #share-root, because that is what
 * the viewer replaces. The bootstrap data and the scripts sit outside it, or
 * mounting would delete the data it was about to read.
 */
function shell(title: string, body: string, head = '', tail = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="${FAVICON}" type="image/svg+xml">
<style>${STYLES}</style>
${head}
</head>
<body>
<div id="share-root">
<main>
  <div class="card">
    <span class="brand">${MARK} Orbit</span>
    ${body}
  </div>
  <footer>Shared through Orbit. The file stays in its owner's own cloud storage.</footer>
</main>
</div>
${tail}
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
      ? /*
         * A real viewer rather than an <img> on a page.
         *
         * Somebody opening a shared photo wants what the owner has: to zoom
         * into a corner, drag around it, and fill the screen. A page that
         * shows a shrunk-to-fit picture and a Download button pushes them to
         * download it just to look at it properly - which is the opposite of
         * what a link is for.
         */
        `<div class="stage" data-zoom>
           <img src="${src}" alt="${name}" draggable="false">
           <div class="zoom-controls">
             <button type="button" data-act="out" aria-label="Zoom out">&minus;</button>
             <button type="button" data-act="reset" aria-label="Fit to the window">Fit</button>
             <button type="button" data-act="in" aria-label="Zoom in">+</button>
             <button type="button" data-act="full" aria-label="Fill the screen">&#x26F6;</button>
           </div>
         </div>`
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

  const bundle = shareBundle();

  /*
   * The data the viewer needs, as JSON rather than as attributes to be
   * scraped back off the markup. `<` is escaped because a file name containing
   * `</script>` would otherwise end the element early - the one way a name can
   * become markup inside a JSON block.
   */
  const bootstrap = JSON.stringify({
    shortId,
    name: share.name,
    mimeType: share.mimeType,
    sizeBytes: share.sizeBytes,
    permission: share.permission,
    expiresAt: share.expiresAt ?? null,
  }).replace(/</g, '\\u003c');

  const head = (bundle?.styles ?? [])
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
    .join('');

  const tail = bundle
    ? `<script type="application/json" id="share-data">${bootstrap}</script>` +
      bundle.scripts
        .map((src) => `<script type="module" src="${escapeHtml(src)}"></script>`)
        .join('')
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
     </div>
     ${preview === 'image' ? viewerScript(input.nonce) : ''}`,
    head,
    tail,
  );
}

/**
 * Zoom and pan for a shared image.
 *
 * Vanilla and inline, on a nonce. This page has no bundle and no framework by
 * design - it is the one thing here a stranger opens - and adding either for a
 * zoom control would be a poor trade.
 */
function viewerScript(nonce: string): string {
  return `<script nonce="${escapeHtml(nonce)}">
(function () {
  var stage = document.querySelector('[data-zoom]');
  if (!stage) return;

  var img = stage.querySelector('img');
  var scale = 1, x = 0, y = 0, dragging = false, lastX = 0, lastY = 0;

  function apply() {
    img.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + scale + ')';
    stage.dataset.zoomed = scale > 1 ? '1' : '';
  }

  function zoom(next, originX, originY) {
    next = Math.min(8, Math.max(1, next));
    if (next === scale) return;

    // Keep whatever is under the pointer under the pointer, which is what
    // makes wheel zoom feel like magnifying rather than jumping.
    var rect = stage.getBoundingClientRect();
    var cx = (originX === undefined ? rect.width / 2 : originX - rect.left) - rect.width / 2;
    var cy = (originY === undefined ? rect.height / 2 : originY - rect.top) - rect.height / 2;

    x = cx - ((cx - x) * next) / scale;
    y = cy - ((cy - y) * next) / scale;
    scale = next;

    if (scale === 1) { x = 0; y = 0; }
    apply();
  }

  stage.addEventListener('wheel', function (e) {
    e.preventDefault();
    zoom(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
  }, { passive: false });

  img.addEventListener('dblclick', function (e) {
    zoom(scale > 1 ? 1 : 2.5, e.clientX, e.clientY);
  });

  img.addEventListener('pointerdown', function (e) {
    if (scale === 1) return;
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    img.setPointerCapture(e.pointerId);
  });

  img.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    x += e.clientX - lastX; y += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    apply();
  });

  ['pointerup', 'pointercancel'].forEach(function (name) {
    img.addEventListener(name, function () { dragging = false; });
  });

  stage.addEventListener('click', function (e) {
    var act = e.target.getAttribute && e.target.getAttribute('data-act');
    if (!act) return;

    if (act === 'in') zoom(scale * 1.4);
    else if (act === 'out') zoom(scale / 1.4);
    else if (act === 'reset') { scale = 1; x = 0; y = 0; apply(); }
    else if (act === 'full') {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (stage.requestFullscreen) stage.requestFullscreen();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === '+' || e.key === '=') zoom(scale * 1.4);
    else if (e.key === '-') zoom(scale / 1.4);
    else if (e.key === '0' || e.key === 'Escape') { scale = 1; x = 0; y = 0; apply(); }
  });
})();
</script>`;
}
