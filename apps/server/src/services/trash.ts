import type { OrbitFile } from '@orbit/shared-types';
import { useAccount } from './accounts.js';
import { readableAccountIds } from './sharing.js';
import { accounts, deletions } from '@orbit/db';
import { and, eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../lib/db.js';
import { decodeCursor, encodeCursor, type Cursor } from '../lib/cursor.js';

/**
 * What has been deleted but not yet destroyed, across every drive that keeps a
 * bin.
 *
 * Worth a page of its own because a deleted file is the one thing somebody
 * comes back for in a hurry, and until now the only way to find one was to open
 * the provider's own website - which is precisely the thing Orbit exists to
 * stop being necessary.
 *
 * Providers disagree about what a bin is, and the capabilities say so rather
 * than the code pretending otherwise: Drive keeps one and will empty it, Dropbox
 * keeps deleted files for thirty days and will restore one but only lets a
 * business plan destroy one early, and an object store has no bin at all - a
 * delete there is final and the page says so instead of offering a way back
 * that does not exist.
 */

export interface TrashedFile extends OrbitFile {
  accountId: string;
  accountNickname: string;
  provider: string;
  catalogueKey: string | null;
  /** False where the provider keeps a bin but will not let this account empty it. */
  canPurge: boolean;
  /**
   * When the provider will destroy it on its own, where that can be worked out.
   *
   * Null more often than not, and that is the honest answer rather than a
   * missing feature. Dropbox reports a deleted entry with no timestamp at all,
   * and Drive populates `trashedTime` only for items in a shared drive - so a
   * file deleted from somebody's own Drive has no knowable deadline.
   *
   * Guessing one from the modified time would be worse than admitting it:
   * somebody told "3 days left" who loses the file tomorrow was misled by
   * Orbit rather than by the provider.
   */
  purgesAt: string | null;
}

/**
 * Records that these went, and when.
 *
 * Called after a delete has succeeded. Never throws: failing to note the time
 * must not turn a successful delete into a reported failure, and the worst it
 * costs is one file in the bin with no deadline beside it.
 */
export async function noteDeleted(
  userId: string,
  accountId: string,
  remoteIds: string[],
): Promise<void> {
  if (remoteIds.length === 0) return;

  try {
    await db()
      .insert(deletions)
      .values(
        remoteIds.map((remoteId) => ({ id: nanoid(), userId, accountId, remoteId })),
      )
      // Deleting something already noted means it was restored and deleted
      // again; the second time is the one that counts.
      .onConflictDoUpdate({
        target: [deletions.accountId, deletions.remoteId],
        set: { deletedAt: new Date().toISOString() },
      });
  } catch {
    // Deliberately silent - see above.
  }
}

/** Forgets a note, once the file has left the bin one way or the other. */
async function forgetDeleted(accountId: string, remoteId: string): Promise<void> {
  try {
    await db()
      .delete(deletions)
      .where(and(eq(deletions.accountId, accountId), eq(deletions.remoteId, remoteId)));
  } catch {
    // A stale note is harmless: nothing reads one for a file that is not in
    // the bin any more.
  }
}

/**
 * How long a provider keeps a deleted file before destroying it.
 *
 * Each is the provider's published policy rather than something Orbit
 * controls; a provider missing from here simply reports no deadline.
 *
 * pCloud is the one that depends on the plan - fifteen days on the free tier,
 * thirty on a paid one - and Orbit cannot see which plan an account is on. The
 * shorter is used, so the deadline shown is never later than the real one: a
 * file that outlives its countdown is a pleasant surprise, one destroyed before
 * it is not.
 */
const RETENTION_DAYS: Record<string, number> = {
  google_drive: 30,
  dropbox: 30,
  pcloud: 15,
};

export interface TrashResult {
  files: TrashedFile[];
  /** Drives that keep no bin at all, so their deletes are final. */
  noBin: Array<{ accountId: string; nickname: string }>;
  problems: Array<{ accountId: string; nickname: string; reason: string }>;
  nextCursor?: string | undefined;
}

export async function listTrash(
  userId: string,
  options: { cursor?: string | undefined } = {},
): Promise<TrashResult> {
  const readable = await readableAccountIds(userId);
  const all = readable.length
    ? await db().select().from(accounts).where(inArray(accounts.id, readable))
    : [];

  const cursor = decodeCursor(options.cursor);
  // Continuing asks only the drives that still had pages left.
  const rows = cursor ? all.filter((row) => cursor[row.id]) : all;
  const nextCursor: Cursor = {};

  const result: TrashResult = { files: [], noBin: [], problems: [] };

  // One query for every note this user has, rather than one per file.
  const noted = new Map(
    (
      await db()
        .select({
          accountId: deletions.accountId,
          remoteId: deletions.remoteId,
          deletedAt: deletions.deletedAt,
        })
        .from(deletions)
        .where(eq(deletions.userId, userId))
    ).map((row) => [`${row.accountId}:${row.remoteId}`, row.deletedAt]),
  );

  const settled = await Promise.allSettled(
    rows.map(async (row) => {
      const active = await useAccount(userId, row.id, 'read');
      if (!active) return { row, files: [] as OrbitFile[] };

      if (!active.adapter.capabilities.trash || !active.adapter.listTrash) {
        return { row, unsupported: true as const };
      }

      const page = await active.adapter.listTrash(active.tokens, cursor?.[row.id]);
      return {
        row,
        files: page.files,
        nextPageToken: page.nextPageToken,
        canPurge: active.adapter.capabilities.purgeTrash,
      };
    }),
  );

  for (const [index, outcome] of settled.entries()) {
    const row = rows[index]!;

    if (outcome.status === 'rejected') {
      // One unreachable drive must not empty the whole page.
      result.problems.push({
        accountId: row.id,
        nickname: row.nickname,
        reason:
          outcome.reason instanceof Error && outcome.reason.message === 'needs_reauth'
            ? 'needs reconnecting'
            : 'could not be reached',
      });
      continue;
    }

    if ('unsupported' in outcome.value && outcome.value.unsupported) {
      result.noBin.push({ accountId: row.id, nickname: row.nickname });
      continue;
    }

    for (const file of outcome.value.files ?? []) {
      const days = RETENTION_DAYS[row.provider];
      /*
       * The provider's own answer first, then Orbit's own note.
       *
       * The provider is authoritative where it speaks - it knows about deletes
       * that never went through Orbit. It mostly does not speak, and then the
       * moment Orbit's own delete succeeded is the honest second-best.
       */
      const since = file.trashedAt ?? noted.get(`${row.id}:${file.remoteId}`);
      const purgesAt =
        since && days
          ? new Date(new Date(since).getTime() + days * 86_400_000).toISOString()
          : null;

      result.files.push({
        ...file,
        accountId: row.id,
        provider: row.provider,
        accountNickname: row.nickname,
        catalogueKey: row.catalogueKey,
        canPurge: 'canPurge' in outcome.value ? Boolean(outcome.value.canPurge) : false,
        purgesAt,
      });
    }

    if ('nextPageToken' in outcome.value && outcome.value.nextPageToken) {
      nextCursor[row.id] = outcome.value.nextPageToken;
    }
  }

  /*
   * Whatever is closest to being destroyed first, then the most recently
   * deleted.
   *
   * Both orderings answer a real question, but they answer different ones:
   * "what did I just lose" and "what am I about to lose for good". The second
   * is the one with a deadline attached, so it wins where there is one.
   */
  result.files.sort((a, b) => {
    if (a.purgesAt && b.purgesAt) return Date.parse(a.purgesAt) - Date.parse(b.purgesAt);
    if (a.purgesAt) return -1;
    if (b.purgesAt) return 1;
    return Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt);
  });
  result.nextCursor = encodeCursor(nextCursor);

  return result;
}

export type TrashAction = { ok: true } | { ok: false; reason: 'not_found' | 'unsupported' };

export interface BulkOutcome {
  succeeded: Array<{ accountId: string; remoteId: string }>;
  failed: Array<{ accountId: string; remoteId: string; reason: string }>;
}

/**
 * Restores or destroys a whole selection.
 *
 * Grouped by drive, and **one at a time within each drive**. Every provider
 * here does this a file at a time anyway - Drive patches one id, Dropbox
 * restores one revision - so firing forty at once buys nothing and is the
 * shape that gets an account rate limited for something the user thought was
 * a single action. Different drives do run at once, since they are different
 * services with separate limits.
 *
 * Never throws for one file. A selection of forty where two fail should report
 * two failures, not lose the other thirty-eight.
 */
async function eachInTurn(
  userId: string,
  targets: Array<{ accountId: string; remoteId: string }>,
  act: (userId: string, accountId: string, remoteId: string) => Promise<TrashAction>,
): Promise<BulkOutcome> {
  const byAccount = new Map<string, string[]>();
  for (const target of targets) {
    byAccount.set(target.accountId, [...(byAccount.get(target.accountId) ?? []), target.remoteId]);
  }

  const outcome: BulkOutcome = { succeeded: [], failed: [] };

  await Promise.all(
    [...byAccount.entries()].map(async ([accountId, remoteIds]) => {
      for (const remoteId of remoteIds) {
        try {
          const result = await act(userId, accountId, remoteId);

          if (result.ok) outcome.succeeded.push({ accountId, remoteId });
          else {
            outcome.failed.push({
              accountId,
              remoteId,
              reason:
                result.reason === 'unsupported'
                  ? 'this drive does not allow it'
                  : 'no such account',
            });
          }
        } catch (err) {
          outcome.failed.push({
            accountId,
            remoteId,
            reason: err instanceof Error ? err.message : 'failed',
          });
        }
      }
    }),
  );

  return outcome;
}

export function restoreMany(
  userId: string,
  targets: Array<{ accountId: string; remoteId: string }>,
): Promise<BulkOutcome> {
  return eachInTurn(userId, targets, restore);
}

export function purgeMany(
  userId: string,
  targets: Array<{ accountId: string; remoteId: string }>,
): Promise<BulkOutcome> {
  return eachInTurn(userId, targets, purge);
}

/**
 * Puts a file back.
 *
 * Needs `write` rather than `delete`: restoring adds a file to the drive, it
 * does not take one away, and somebody trusted to upload is trusted to undo a
 * deletion.
 */
export async function restore(
  userId: string,
  accountId: string,
  remoteId: string,
): Promise<TrashAction> {
  const active = await useAccount(userId, accountId, 'write');
  if (!active) return { ok: false, reason: 'not_found' };

  if (!active.adapter.capabilities.trash || !active.adapter.restoreFromTrash) {
    return { ok: false, reason: 'unsupported' };
  }

  await active.adapter.restoreFromTrash(active.tokens, remoteId);
  await forgetDeleted(accountId, remoteId);
  return { ok: true };
}

/**
 * Destroys a file in the bin.
 *
 * Needs `delete`, and gated again on `purgeTrash`: this is the one operation in
 * Orbit with nothing behind it, and a provider that keeps a bin is not
 * necessarily one that lets an ordinary account empty it.
 */
export async function purge(
  userId: string,
  accountId: string,
  remoteId: string,
): Promise<TrashAction> {
  const active = await useAccount(userId, accountId, 'delete');
  if (!active) return { ok: false, reason: 'not_found' };

  if (!active.adapter.capabilities.purgeTrash || !active.adapter.purgeFromTrash) {
    return { ok: false, reason: 'unsupported' };
  }

  await active.adapter.purgeFromTrash(active.tokens, remoteId);
  await forgetDeleted(accountId, remoteId);
  return { ok: true };
}
