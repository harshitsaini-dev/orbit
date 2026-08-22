import sharp from 'sharp';
import type { AccountTokens, ProviderAdapter } from '@orbit/shared-types';
import { pdfFirstPage, renderers, videoFrame } from './renderers.js';

/**
 * Thumbnails for providers that do not make their own.
 *
 * Drive, OneDrive and Dropbox render previews server-side and Orbit just
 * proxies them. An object store does not, so a bucket of photos showed nothing
 * but file icons — and serving the originals instead means a grid of forty
 * tiles pulling tens of megabytes to draw a few hundred pixels each.
 *
 * So they are made here: fetched once, resized, re-encoded small, and kept in
 * memory. Never written to disk — a derived image is still bytes, and not
 * storing bytes is the rule the product is built on. Memory is also the honest
 * place for it: the instance restarts often enough that a disk cache would need
 * managing for very little gain.
 */

/** WebP at this quality is visually clean at tile size and a few kilobytes. */
const QUALITY = 72;

/** Above this the source costs more to fetch and decode than a tile is worth. */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

/**
 * How much of a video to pull before giving up on it.
 *
 * A frame needs the header, the index, and enough of the first second to decode
 * - not two gigabytes. An MP4 written with `faststart` has all of that at the
 * front; one that does not simply returns no thumbnail, which is better than
 * downloading the file to find out.
 */
const VIDEO_PREFIX_BYTES = 12 * 1024 * 1024;

/** A PDF's first page is near the front, but the cross-reference table is not. */
const PDF_MAX_BYTES = 40 * 1024 * 1024;

/** Roughly a few hundred tiles. Bounded so a big folder cannot exhaust the heap. */
const MAX_CACHE_BYTES = 32 * 1024 * 1024;

/**
 * Two at a time.
 *
 * Decoding is CPU-bound and this process also serves requests somebody is
 * waiting for. A grid scrolling past four hundred images would otherwise put
 * four hundred decodes ahead of every listing.
 */
const MAX_CONCURRENT = 2;

export interface Thumbnail {
  bytes: Buffer;
  contentType: string;
}

const cache = new Map<string, Thumbnail>();
let cacheBytes = 0;

/** In-flight work, so forty tiles of the same image decode once. */
const inFlight = new Map<string, Promise<Thumbnail | null>>();

let running = 0;
const waiting: Array<() => void> = [];

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running += 1;

  try {
    return await work();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

function remember(key: string, thumbnail: Thumbnail): void {
  // Oldest out first. A Map iterates in insertion order, which is the only
  // ordering this needs.
  while (cacheBytes + thumbnail.bytes.byteLength > MAX_CACHE_BYTES && cache.size > 0) {
    const [oldestKey, oldest] = cache.entries().next().value as [string, Thumbnail];
    cache.delete(oldestKey);
    cacheBytes -= oldest.bytes.byteLength;
  }

  cache.set(key, thumbnail);
  cacheBytes += thumbnail.bytes.byteLength;
}

/** What sharp can decode. Not a guess: these are the formats libvips reads. */
const DECODABLE = /\.(jpe?g|png|gif|webp|avif|tiff?|heic|heif|bmp|svg)$/i;

const VIDEO = /\.(mp4|m4v|mov|webm|mkv|avi|mpe?g|3gp|ogv|ts|m2ts|wmv|flv)$/i;

export type Source = 'image' | 'video' | 'pdf';

/**
 * What this file could be turned into a tile from, or null.
 *
 * Video and PDF depend on tools that may not be installed - see `renderers.ts`.
 * Asking here rather than at the point of use means a machine without them
 * never fetches a byte of a video it cannot decode.
 */
export function sourceKind(name: string, mimeType: string): Source | null {
  const type = mimeType.toLowerCase();

  // SVG is excluded deliberately. sharp renders it, but rendering an untrusted
  // SVG means running its references through a parser to make a picture nobody
  // asked to be safe.
  if (type === 'image/svg+xml' || /\.svg$/i.test(name)) return null;

  // Object stores label almost everything octet-stream, so the name decides
  // whenever the type is not specific.
  if (type.startsWith('image/') || DECODABLE.test(name)) return 'image';

  const available = renderers();
  if (available.video && (type.startsWith('video/') || VIDEO.test(name))) return 'video';
  if (available.pdf && (type === 'application/pdf' || /\.pdf$/i.test(name))) return 'pdf';

  return null;
}

/** Kept for the shape the callers read best. */
export function canRender(name: string, mimeType: string): boolean {
  return sourceKind(name, mimeType) !== null;
}

export interface RenderInput {
  adapter: ProviderAdapter;
  tokens: AccountTokens;
  remoteId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  size: number;
}

/**
 * A thumbnail for one file, made if it has to be.
 *
 * Returns null when the file is not something that can be rendered, which the
 * caller shows as an icon — the same thing it would show for a provider that
 * had no thumbnail either.
 */
export async function renderThumbnail(input: RenderInput): Promise<Thumbnail | null> {
  const kind = sourceKind(input.name, input.mimeType);
  if (!kind) return null;

  // Images are read whole, so an enormous one is refused before it is fetched.
  // A video is read as a prefix, so its own size does not matter; a PDF is read
  // whole but tolerates more, because the page is worth more than a photo is.
  if (kind === 'image' && input.sizeBytes > MAX_SOURCE_BYTES) return null;
  if (kind === 'pdf' && input.sizeBytes > PDF_MAX_BYTES) return null;

  const key = `${input.remoteId}:${input.size}`;

  const cached = cache.get(key);
  if (cached) {
    // Touched, so the busy tiles are the ones that survive eviction.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const existing = inFlight.get(key);
  if (existing) return existing;

  const work = slot(async () => {
    // Only as much as the renderer needs. A two-gigabyte video must not be
    // pulled through the server to draw a tile.
    const range =
      kind === 'video' && input.sizeBytes > VIDEO_PREFIX_BYTES
        ? { start: 0, end: VIDEO_PREFIX_BYTES - 1 }
        : undefined;

    const stream = await input.adapter.getFileStream(input.tokens, input.remoteId, range);
    const fetched = Buffer.from(await new Response(stream.stream as never).arrayBuffer());

    // Video and PDF arrive as a PNG from an external renderer; an image is
    // already one. From here all three are the same problem.
    const source =
      kind === 'video'
        ? await videoFrame(fetched)
        : kind === 'pdf'
          ? await pdfFirstPage(fetched)
          : fetched;

    // The tool was there but could not read this file - a video whose index is
    // at the end, an encrypted PDF. An icon is the honest answer.
    if (!source) return null;

    const bytes = await sharp(source, { failOn: 'none' })
      // Inside, not cropped: a grid of photos with their edges cut off is worse
      // than one with letterboxing.
      .rotate()
      .resize(input.size, input.size, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: QUALITY })
      .toBuffer();

    const thumbnail: Thumbnail = { bytes, contentType: 'image/webp' };
    remember(key, thumbnail);
    return thumbnail;
  })
    .catch(() => null)
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, work);
  return work;
}

/** For the line in settings that offers to clear it. */
export function thumbnailCacheSize(): { count: number; bytes: number } {
  return { count: cache.size, bytes: cacheBytes };
}

export function clearThumbnailCache(): void {
  cache.clear();
  cacheBytes = 0;
}
