import { getAdapter } from '@orbit/adapters';
import { accounts, filesMirror } from '@orbit/db';
import { summarise, type CategoryTotal } from '@orbit/shared-types';
import { eq } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { useAccount } from './accounts.js';

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

export interface SharedDriveEntry {
  accountId: string;
  accountNickname: string;
  /** The drive's own id, which is also its root folder id. */
  driveId: string;
  name: string;
  path: string;
}

export interface StorageSummary {
  groups: StorageGroup[];
  /**
   * Drives that belong to an organisation, listed but not measured.
   *
   * Named here because leaving them out of the storage views entirely was the
   * other way to be wrong: they are not part of anybody's allowance, but a
   * person looking at their storage still wants to know they exist and where.
   *
   * No size: Google reports no quota for a shared drive - the organisation's
   * storage is pooled - so the only way to a number is enumerating the whole
   * drive, which is not something to do on every dashboard load.
   */
  sharedDrives: SharedDriveEntry[];
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

/**
 * The shared drives visible to these accounts.
 *
 * One extra request per Google account and nothing at all for the rest, which
 * is what makes it affordable to include here. An account with none - the
 * usual case - answers with an empty list rather than an error.
 */
async function sharedDrivesFor(
  userId: string,
  rows: Array<typeof accounts.$inferSelect>,
): Promise<SharedDriveEntry[]> {
  const found = await Promise.all(
    rows
      .filter((row) => row.provider === 'google_drive')
      .map(async (row) => {
        try {
          const active = await useAccount(userId, row.id, 'read');
          if (!active) return [];

          const page = await active.adapter.listFolder(active.tokens, SHARED_DRIVES_PATH);

          return page.files.map((file) => ({
            accountId: row.id,
            accountNickname: row.nickname,
            driveId: file.remoteId,
            name: file.name,
            path: file.virtualPath,
          }));
        } catch {
          // An account with none answers 404 for that folder. That is the
          // ordinary case, not a failure worth surfacing.
          return [];
        }
      }),
  );

  return found.flat();
}

/** Orbit's own name for the folder it synthesises to hold them. */
const SHARED_DRIVES_PATH = '/Shared drives';

/**
 * A measured shared drive, remembered.
 *
 * Measuring one means listing every file in it, which is the reason it is not
 * done on every dashboard load. Once done it is worth keeping: a shared drive
 * does not change size between one look and the next in any way that matters
 * for a breakdown.
 */
const measured = new Map<string, MeasuredDrive>();

/** Long enough that browsing back does not re-measure, short enough to be true. */
const MEASURE_TTL_MS = 30 * 60 * 1000;

/** A page cap, so one enormous drive cannot run for minutes. */
const MAX_PAGES = 25;

export interface MeasuredDrive {
  sizeBytes: number;
  fileCount: number;
  totals: CategoryTotal[];
  /** True when the cap was hit, so the figures are a floor rather than a total. */
  partial: boolean;
  measuredAt: number;
}

/**
 * Measures one shared drive by listing it, or returns what was measured before.
 *
 * Asked for explicitly rather than computed with the summary. Google reports no
 * quota for a shared drive - the organisation's storage is pooled - so there is
 * no cheap number to read, and enumerating is the only way to one.
 */
export async function measureSharedDrive(
  userId: string,
  accountId: string,
  driveId: string,
): Promise<MeasuredDrive | null> {
  const key = `${accountId}:${driveId}`;
  const cached = measured.get(key);
  if (cached && Date.now() - cached.measuredAt < MEASURE_TTL_MS) return cached;

  const active = await useAccount(userId, accountId, 'read');
  if (!active?.adapter.listAllUnder) return null;

  const files: Array<{ name: string; mimeType: string; sizeBytes: number; isFolder: boolean }> = [];
  let pageToken: string | undefined;
  let pages = 0;
  let partial = false;

  do {
    const page = await active.adapter.listAllUnder(active.tokens, driveId, pageToken);
    files.push(...page.files);
    pageToken = page.nextPageToken;

    if (++pages >= MAX_PAGES && pageToken) {
      // Said rather than silently stopped: a truncated total that looks whole
      // is worse than one that admits it.
      partial = true;
      break;
    }
  } while (pageToken);

  const result: MeasuredDrive = {
    sizeBytes: files.reduce((sum, file) => sum + (file.isFolder ? 0 : file.sizeBytes), 0),
    fileCount: files.filter((file) => !file.isFolder).length,
    totals: summarise(files),
    partial,
    measuredAt: Date.now(),
  };

  measured.set(key, result);
  return result;
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
    sharedDrives: await sharedDrivesFor(userId, rows),
    overall: {
      usedBytes: ordered.reduce((sum, group) => sum + group.usedBytes, 0),
      quotaBytes: ordered.reduce((sum, group) => sum + group.quotaBytes, 0),
      totals: summarise(files),
      fileCount: files.filter((file) => !file.isFolder).length,
    },
    unindexed,
  };
}
