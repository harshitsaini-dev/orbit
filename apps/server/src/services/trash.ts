import type { OrbitFile } from '@orbit/shared-types';
import { useAccount } from './accounts.js';
import { readableAccountIds } from './sharing.js';
import { accounts } from '@orbit/db';
import { inArray } from 'drizzle-orm';
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
}

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
      result.files.push({
        ...file,
        accountId: row.id,
        provider: row.provider,
        accountNickname: row.nickname,
        catalogueKey: row.catalogueKey,
        canPurge: 'canPurge' in outcome.value ? Boolean(outcome.value.canPurge) : false,
      });
    }

    if ('nextPageToken' in outcome.value && outcome.value.nextPageToken) {
      nextCursor[row.id] = outcome.value.nextPageToken;
    }
  }

  // Most recently deleted first: somebody opening this page is almost always
  // after something they have just lost.
  result.files.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
  result.nextCursor = encodeCursor(nextCursor);

  return result;
}

export type TrashAction = { ok: true } | { ok: false; reason: 'not_found' | 'unsupported' };

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
  return { ok: true };
}
