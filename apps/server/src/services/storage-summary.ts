import { getAdapter } from '@orbit/adapters';
import { accounts, filesMirror } from '@orbit/db';
import { summarise, type CategoryTotal } from '@orbit/shared-types';
import { eq } from 'drizzle-orm';
import { db } from '../lib/db.js';

/**
 * What is stored, grouped by the kind of storage it is in.
 *
 * A Google Drive and an S3 bucket are not the same sort of thing and adding
 * them into one figure says less than either alone. A Drive has an allowance
 * you can run out of, so "12 GB of 15 GB" is the number that matters. A bucket
 * has no allowance at all - it has a bill - so a percentage of nothing is a
 * meaningless bar, and what matters is simply how much is in there.
 *
 * Split on `reportsQuota` rather than on the provider's name: it is the
 * capability that actually distinguishes them, and it keeps a new adapter on
 * the right side of the line without anything being added here.
 *
 * The totals come from the mirror rather than from each provider, so this is
 * one query instead of one request per account. It is therefore only as
 * current as the last sync, which the caller is told.
 */

export type StorageKind = 'allowance' | 'metered';

export interface SummaryAccount {
  accountId: string;
  nickname: string;
  provider: string;
  catalogueKey: string | null;
  usedBytes: number;
  quotaBytes: number;
  /** From the mirror, so zero until the account has been synced. */
  indexedBytes: number;
  fileCount: number;
}

export interface StorageGroup {
  kind: StorageKind;
  accounts: SummaryAccount[];
  /** As reported by each provider, which is the truth about what is stored. */
  usedBytes: number;
  /** Zero for metered storage, which has no allowance to be a fraction of. */
  quotaBytes: number;
  /** What the files are, from the mirror. Empty until something is synced. */
  totals: CategoryTotal[];
  fileCount: number;
}

export interface StorageSummary {
  groups: StorageGroup[];
  /** Everything at once, for the one figure that answers "how much have I got". */
  overall: {
    usedBytes: number;
    quotaBytes: number;
    totals: CategoryTotal[];
    fileCount: number;
  };
  /** How many accounts have nothing indexed, so a partial answer says so. */
  unindexed: number;
}

export async function storageSummary(userId: string): Promise<StorageSummary> {
  const rows = await db().select().from(accounts).where(eq(accounts.userId, userId));

  // Names and sizes only: enough for `summarise`, and it avoids pulling every
  // column of several thousand rows to add up two of them.
  const files = await db()
    .select({
      accountId: filesMirror.accountId,
      name: filesMirror.name,
      mimeType: filesMirror.mimeType,
      sizeBytes: filesMirror.sizeBytes,
      isFolder: filesMirror.isFolder,
    })
    .from(filesMirror)
    .innerJoin(accounts, eq(accounts.id, filesMirror.accountId))
    .where(eq(accounts.userId, userId));

  const byAccount = new Map<string, typeof files>();
  for (const file of files) {
    byAccount.set(file.accountId, [...(byAccount.get(file.accountId) ?? []), file]);
  }

  const groups = new Map<StorageKind, StorageGroup>();
  let unindexed = 0;

  for (const row of rows) {
    const mine = byAccount.get(row.id) ?? [];
    const kind: StorageKind = getAdapter(row.provider).capabilities.reportsQuota
      ? 'allowance'
      : 'metered';

    if (mine.length === 0) unindexed += 1;

    const group = groups.get(kind) ?? {
      kind,
      accounts: [],
      usedBytes: 0,
      quotaBytes: 0,
      totals: [],
      fileCount: 0,
    };

    group.accounts.push({
      accountId: row.id,
      nickname: row.nickname,
      provider: row.provider,
      catalogueKey: row.catalogueKey,
      usedBytes: row.usedBytes,
      quotaBytes: row.quotaBytes,
      indexedBytes: mine.reduce((sum, file) => sum + (file.isFolder ? 0 : file.sizeBytes), 0),
      fileCount: mine.filter((file) => !file.isFolder).length,
    });

    group.usedBytes += row.usedBytes;
    group.quotaBytes += row.quotaBytes;
    groups.set(kind, group);
  }

  // Summarised per group in one pass at the end rather than per account, so a
  // category that spans several accounts is one entry rather than several.
  for (const [kind, group] of groups) {
    const ids = new Set(group.accounts.map((account) => account.accountId));
    const mine = files.filter((file) => ids.has(file.accountId));

    group.totals = summarise(mine);
    group.fileCount = mine.filter((file) => !file.isFolder).length;
    groups.set(kind, group);
  }

  // Allowance first: it is the half that can run out, and therefore the half
  // somebody opening this is more likely to be here about.
  const ordered = [groups.get('allowance'), groups.get('metered')].filter(
    (group): group is StorageGroup => group !== undefined,
  );

  return {
    groups: ordered,
    overall: {
      usedBytes: ordered.reduce((sum, group) => sum + group.usedBytes, 0),
      quotaBytes: ordered.reduce((sum, group) => sum + group.quotaBytes, 0),
      totals: summarise(files),
      fileCount: files.filter((file) => !file.isFolder).length,
    },
    unindexed,
  };
}
