import sharp from 'sharp';
import type { AccountTokens, ProviderAdapter } from '@orbit/shared-types';

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

export function canRender(name: string, mimeType: string): boolean {
  const type = mimeType.toLowerCase();

  // SVG is excluded deliberately. sharp renders it, but rendering an untrusted
  // SVG means running its references through a parser to make a picture nobody
  // asked to be safe.
  if (type === 'image/svg+xml' || /\.svg$/i.test(name)) return false;

  if (type.startsWith('image/')) return true;

  // Object stores label almost everything octet-stream, so the name decides.
  return DECODABLE.test(name);
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
  if (!canRender(input.name, input.mimeType)) return null;
  if (input.sizeBytes > MAX_SOURCE_BYTES) return null;

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
    const stream = await input.adapter.getFileStream(input.tokens, input.remoteId);
    const source = Buffer.from(await new Response(stream.stream as never).arrayBuffer());

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
