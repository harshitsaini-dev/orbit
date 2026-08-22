import type { CategoryTotal, FileCategory, StorageBreakdown } from '@orbit/shared-types';
import { summarise } from '@orbit/shared-types';
import { useAccount } from './accounts.js';

/**
 * A Google One style breakdown of what is actually taking up the space.
 *
 * There is no aggregate endpoint on any of these providers, so the only way to
 * get it is to enumerate. `listAllFiles` does that flat rather than folder by
 * folder, which on a large drive is the difference between a few dozen requests
 * and several thousand.
 *
 * The scan is bounded. An account with a million files would otherwise tie up
 * the single free backend instance for minutes; hitting the bound reports
 * `partial: true` rather than quietly presenting an undercount as the total.
 */
const DEFAULT_MAX_PAGES = 60;

export interface ScanOptions {
  maxPages?: number;
  signal?: AbortSignal;
}

export async function computeBreakdown(
  userId: string,
  accountId: string,
  options: ScanOptions = {},
): Promise<StorageBreakdown | null> {
  const active = await useAccount(userId, accountId, 'read');
  if (!active) return null;

  if (!active.adapter.capabilities.flatEnumeration) {
    throw new Error('breakdown_unsupported');
  }

  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const running = new Map<FileCategory, CategoryTotal>();

  let cursor: string | undefined;
  let pages = 0;
  let partial = false;

  do {
    if (options.signal?.aborted) {
      partial = true;
      break;
    }

    const page = await active.adapter.listAllFiles(active.tokens, cursor);

    // Fold each page in as it arrives rather than accumulating every file:
    // a large drive would otherwise hold hundreds of thousands of objects in
    // memory for no reason.
    for (const total of summarise(page.files)) {
      const existing = running.get(total.category);
      if (existing) {
        existing.fileCount += total.fileCount;
        existing.sizeBytes += total.sizeBytes;
      } else {
        running.set(total.category, { ...total });
      }
    }

    cursor = page.nextPageToken;
    pages += 1;

    if (cursor && pages >= maxPages) {
      partial = true;
      break;
    }
  } while (cursor);

  const totals = [...running.values()].sort(
    (a, b) => b.sizeBytes - a.sizeBytes || b.fileCount - a.fileCount,
  );

  return {
    accountId,
    totals,
    fileCount: totals.reduce((sum, total) => sum + total.fileCount, 0),
    sizeBytes: totals.reduce((sum, total) => sum + total.sizeBytes, 0),
    partial,
    scannedAt: new Date().toISOString(),
  };
}

/**
 * Scans are slow and the answer barely moves, so a completed one is reused.
 * Cached in memory rather than the database because it is derived data that a
 * restart can cheaply rebuild — and because the mirror in Phase 6 will make
 * this a query rather than a scan, at which point the cache goes away.
 */
const cache = new Map<string, StorageBreakdown>();
const CACHE_TTL_MS = 30 * 60 * 1000;

export async function getBreakdown(
  userId: string,
  accountId: string,
  options: ScanOptions & { force?: boolean } = {},
): Promise<StorageBreakdown | null> {
  const key = `${userId}:${accountId}`;
  const cached = cache.get(key);

  if (!options.force && cached && Date.now() - Date.parse(cached.scannedAt) < CACHE_TTL_MS) {
    return cached;
  }

  const fresh = await computeBreakdown(userId, accountId, options);
  if (fresh) cache.set(key, fresh);
  return fresh;
}

export function forgetBreakdown(userId: string, accountId: string): void {
  cache.delete(`${userId}:${accountId}`);
}

export function clearBreakdownCache(): void {
  cache.clear();
}
