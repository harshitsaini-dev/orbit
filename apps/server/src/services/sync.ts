import { getAdapter, isGrantRevoked, ProviderError } from '@orbit/adapters';
import { accounts, filesMirror, syncLog } from '@orbit/db';
import type { OrbitFile } from '@orbit/shared-types';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../lib/db.js';
import { hub } from '../lib/ws.js';
import { useAccount } from './accounts.js';

/**
 * Keeping a local mirror of what is in each account.
 *
 * The mirror is metadata only — names, paths, sizes, checksums, never bytes.
 * What it buys is everything that would otherwise be a request per account per
 * question: finding duplicates across clouds, counting what is stored, and
 * answering a search without waiting for the slowest provider.
 *
 * Two ways in. A provider with a delta feed is asked what changed since last
 * time, which is cheap enough to run often. One without is enumerated in full,
 * which is not — so it is capped, and the cap is recorded rather than hidden.
 */

/** A full enumeration is paid for in requests; past this it is not worth it. */
const MAX_FULL_PAGES = 40;

/** One delta pass follows this many pages before leaving the rest for next time. */
const MAX_DELTA_PAGES = 20;

export interface SyncResult {
  accountId: string;
  status: 'ok' | 'error';
  changed: number;
  deleted: number;
  durationMs: number;
  message?: string;
  /** True when the pass stopped at its cap rather than at the end. */
  partial: boolean;
}

/** Upserts a page of files, keyed on the pair the provider guarantees unique. */
async function writeFiles(accountId: string, files: OrbitFile[]): Promise<void> {
  if (files.length === 0) return;

  const now = new Date().toISOString();

  for (const file of files) {
    await db()
      .insert(filesMirror)
      .values({
        id: nanoid(),
        accountId,
        remoteFileId: file.remoteId,
        virtualPath: file.virtualPath,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        isFolder: file.isFolder,
        starred: file.starred,
        checksum: file.checksum ?? null,
        modifiedAt: file.modifiedAt,
        syncedAt: now,
      })
      // A file seen again is the same file: updated in place, so its row keeps
      // the id anything else may have referenced.
      .onConflictDoUpdate({
        target: [filesMirror.accountId, filesMirror.remoteFileId],
        set: {
          virtualPath: file.virtualPath,
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          isFolder: file.isFolder,
          starred: file.starred,
          checksum: file.checksum ?? null,
          modifiedAt: file.modifiedAt,
          syncedAt: now,
        },
      });
  }
}

async function forgetFiles(accountId: string, remoteIds: string[]): Promise<void> {
  if (remoteIds.length === 0) return;

  await db()
    .delete(filesMirror)
    .where(
      and(eq(filesMirror.accountId, accountId), inArray(filesMirror.remoteFileId, remoteIds)),
    );
}

/**
 * Syncs one account.
 *
 * Never throws: a provider having a bad afternoon must not stop the pass for
 * every other account, and the failure is recorded where it can be seen rather
 * than logged and lost.
 */
export async function syncAccount(userId: string, accountId: string): Promise<SyncResult> {
  const startedAt = Date.now();
  hub.publish(`sync:${accountId}`, { type: 'sync:status', accountId, status: 'running' });

  const finish = async (result: Omit<SyncResult, 'accountId' | 'durationMs'>): Promise<SyncResult> => {
    const durationMs = Date.now() - startedAt;

    await db().insert(syncLog).values({
      id: nanoid(),
      accountId,
      status: result.status,
      deltaCount: result.changed + result.deleted,
      durationMs,
      message: result.message ?? null,
    });

    hub.publish(`sync:${accountId}`, {
      type: 'sync:status',
      accountId,
      status: result.status,
      deltaCount: result.changed + result.deleted,
    });

    return { accountId, durationMs, ...result };
  };

  try {
    const active = await useAccount(userId, accountId, 'read');
    if (!active) {
      return await finish({
        status: 'error',
        changed: 0,
        deleted: 0,
        partial: false,
        message: 'The account is no longer connected',
      });
    }

    const adapter = getAdapter(active.row.provider);
    let changed = 0;
    let deleted = 0;
    let partial = false;

    /**
     * A delta feed reports what changed since a point in time, and a fresh
     * cursor means "from now on" - so the first pass returns nothing and the
     * mirror would only ever learn about files that changed *after* Orbit
     * connected. A mirror has to be seeded before it can be followed.
     */
    const needsBaseline = adapter.capabilities.delta && !active.row.deltaCursor;

    if (needsBaseline && adapter.capabilities.flatEnumeration) {
      let pageToken: string | undefined;
      let pages = 0;

      for (;;) {
        const page = await adapter.listAllFiles(active.tokens, pageToken);
        await writeFiles(accountId, page.files);

        changed += page.files.length;
        pageToken = page.nextPageToken;
        pages += 1;

        if (!pageToken) break;
        if (pages >= MAX_FULL_PAGES) {
          partial = true;
          break;
        }
      }
    }

    if (adapter.capabilities.delta) {
      let cursor = active.row.deltaCursor;
      let pages = 0;

      for (;;) {
        const result = await adapter.listChangesSince(active.tokens, cursor);

        await writeFiles(accountId, result.changed);
        await forgetFiles(accountId, result.deletedRemoteIds);

        changed += result.changed.length;
        deleted += result.deletedRemoteIds.length;
        cursor = result.cursor;
        pages += 1;

        // The cursor is stored every page, not at the end: a pass cut short by
        // a restart then resumes rather than starting the enumeration again.
        await db()
          .update(accounts)
          .set({ deltaCursor: cursor, lastSyncedAt: new Date().toISOString() })
          .where(eq(accounts.id, accountId));

        if (!result.hasMore) break;
        if (pages >= MAX_DELTA_PAGES) {
          // Not an error: the cursor is saved, so the next pass carries on from
          // exactly here.
          partial = true;
          break;
        }
      }
    } else if (adapter.capabilities.flatEnumeration) {
      let pageToken: string | undefined;
      let pages = 0;

      for (;;) {
        const page = await adapter.listAllFiles(active.tokens, pageToken);
        await writeFiles(accountId, page.files);

        changed += page.files.length;
        pageToken = page.nextPageToken;
        pages += 1;

        if (!pageToken) break;
        if (pages >= MAX_FULL_PAGES) {
          partial = true;
          break;
        }
      }

      await db()
        .update(accounts)
        .set({ lastSyncedAt: new Date().toISOString() })
        .where(eq(accounts.id, accountId));
    } else {
      return await finish({
        status: 'ok',
        changed: 0,
        deleted: 0,
        partial: false,
        message: `${active.row.provider} cannot be enumerated, so it has no mirror`,
      });
    }

    return await finish({
      status: 'ok',
      changed,
      deleted,
      partial,
      ...(partial ? { message: 'Stopped at the page limit; the next pass continues' } : {}),
    });
  } catch (err) {
    // A dead grant is the one failure worth acting on: the account is marked so
    // the UI can ask for a reconnect instead of retrying every hour forever.
    if (err instanceof ProviderError && isGrantRevoked(err)) {
      await db()
        .update(accounts)
        .set({ status: 'needs_reauth' })
        .where(eq(accounts.id, accountId));
    }

    return await finish({
      status: 'error',
      changed: 0,
      deleted: 0,
      partial: false,
      message: err instanceof Error ? err.message : 'The sync failed',
    });
  }
}

/**
 * Syncs every connected account, one at a time.
 *
 * Sequential on purpose: the whole point of running this on a schedule is that
 * nobody is waiting for it, and a fleet of concurrent enumerations on a 512MB
 * instance competes with the requests that somebody *is* waiting for.
 */
export async function syncAll(): Promise<SyncResult[]> {
  const rows = await db()
    .select({ id: accounts.id, userId: accounts.userId, status: accounts.status })
    .from(accounts);

  const results: SyncResult[] = [];

  for (const row of rows) {
    // An account already known to need reconnecting will only fail again, and
    // the failure is already recorded against it.
    if (row.status === 'needs_reauth') continue;
    results.push(await syncAccount(row.userId, row.id));
  }

  return results;
}

/** What the mirror holds for one account, for the status line in the UI. */
export async function mirrorSize(accountId: string): Promise<number> {
  const rows = await db()
    .select({ id: filesMirror.id })
    .from(filesMirror)
    .where(eq(filesMirror.accountId, accountId));

  return rows.length;
}

/** The last few passes for one account, newest first. */
export async function recentSyncs(
  accountId: string,
  limit = 5,
): Promise<Array<{ status: string; deltaCount: number; durationMs: number; message: string | null; ranAt: string }>> {
  return db()
    .select({
      status: syncLog.status,
      deltaCount: syncLog.deltaCount,
      durationMs: syncLog.durationMs,
      message: syncLog.message,
      ranAt: syncLog.ranAt,
    })
    .from(syncLog)
    .where(eq(syncLog.accountId, accountId))
    .orderBy(desc(syncLog.ranAt))
    .limit(limit);
}
