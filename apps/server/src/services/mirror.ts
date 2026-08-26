import { accounts, filesMirror } from '@orbit/db';
import type { FileCategory, OrbitFile } from '@orbit/shared-types';
import { categorise } from '@orbit/shared-types';
import { and, asc, desc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../lib/db.js';
import type { SearchRequest } from './search.js';
import type { ViewResult, WorkspaceFile } from './views.js';

/**
 * Answering from the local mirror instead of the provider.
 *
 * The mirror has existed since the first sync engine, but only duplicates and
 * the storage breakdown ever read it - browsing and searching went to the
 * provider every time. That is a network round trip per page, in a chain,
 * because each page needs the cursor the previous one returned. A folder of
 * fifty thousand files is fifty of those; a search is all of them again.
 *
 * The same question against SQLite is one indexed query. The mirror is
 * metadata only, so this changes nothing about the rule that Orbit stores no
 * file bytes - and nothing about where bytes come from, because opening or
 * downloading a file still goes to the provider.
 *
 * What it does change is freshness, and that was meant to be the whole trade:
 * a listing as current as the last sync pass, in exchange for not waiting on a
 * chain of round trips.
 *
 * It turned out not to be the whole trade - see MIRROR_ANSWERS_LISTINGS below,
 * which is why none of this currently answers a listing. The queries and their
 * tests are kept because the shortcoming is in what the mirror *contains*, not
 * in how it is read.
 */

/**
 * Whether the mirror may answer listings and searches. It may not, yet.
 *
 * The mirror is not a file tree, and reading it as one was a mistake made by
 * assuming rather than checking. It was built to answer "what do you have" -
 * the storage breakdown and the duplicate finder - and both of those need
 * names, sizes and checksums, never paths.
 *
 * Two things follow from that, and both are visibly wrong when browsing:
 *
 *   - **Every adapter drops folders from its flat enumeration.** So a folder
 *     listing out of the mirror shows files and no subfolders at all.
 *   - **Google Drive files have no real path in it.** `listAllFiles` and the
 *     delta both filed everything as `/${name}`, so 4,860 of 5,214 rows sat at
 *     the root. Browsing the root showed the whole drive flattened, and a file
 *     appeared to come back every time a sync pass rewrote its row.
 *
 * Pressing Refresh went to the provider and looked right, which made a real
 * data problem read as a display glitch.
 *
 * Everything else the mirror work added stands and is still worth having: the
 * created date, the indexes, the FTS table, write-through on every mutation,
 * and a delta that now resolves real paths. What is switched off is only the
 * decision to *read* it for browsing and search, until it actually models
 * folders and paths for every provider - which is its own piece of work, with
 * its own re-enumeration of what is already stored.
 *
 * Flip this when that is true. The read path and its tests are left in place
 * deliberately, so turning it back on is one line rather than a rewrite.
 */
export const MIRROR_ANSWERS_LISTINGS = false;

/** Rows per page. Larger than a provider page, because there is no round trip. */
export const MIRROR_PAGE = 1000;

/**
 * Upserts files, keyed on the pair the provider guarantees unique.
 *
 * Used by the sync pass and by every route that changes something. The second
 * of those is what makes reading from the mirror bearable: a sync tick is
 * minutes away, and a file somebody just uploaded disappearing until then
 * would be read as data loss, not as staleness.
 */
export async function rememberInMirror(accountId: string, files: OrbitFile[]): Promise<void> {
  if (files.length === 0) return;

  const now = new Date().toISOString();

  for (const file of files) {
    const values = {
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
      createdAt: file.createdAt ?? null,
      syncedAt: now,
    };

    await db()
      .insert(filesMirror)
      .values({ id: nanoid(), ...values })
      // A file seen again is the same file: updated in place, so its row keeps
      // the id anything else may have referenced.
      .onConflictDoUpdate({
        target: [filesMirror.accountId, filesMirror.remoteFileId],
        set: values,
      });
  }
}

/** Drops rows by the provider's own id. */
export async function forgetFromMirror(accountId: string, remoteIds: string[]): Promise<void> {
  if (remoteIds.length === 0) return;

  await db()
    .delete(filesMirror)
    .where(and(eq(filesMirror.accountId, accountId), inArray(filesMirror.remoteFileId, remoteIds)));
}

/**
 * Drops rows, and anything filed underneath the folders among them.
 *
 * Deleting a folder deletes what is under it, but the provider reports only
 * the folder. Left alone, its children would stay in the mirror and keep being
 * listed and found by search - a folder that is gone, still full of files that
 * are also gone.
 */
export async function forgetWithSubtrees(accountId: string, remoteIds: string[]): Promise<void> {
  if (remoteIds.length === 0) return;

  const rows = await db()
    .select({ isFolder: filesMirror.isFolder, virtualPath: filesMirror.virtualPath })
    .from(filesMirror)
    .where(
      and(eq(filesMirror.accountId, accountId), inArray(filesMirror.remoteFileId, remoteIds)),
    );

  for (const row of rows.filter((row) => row.isFolder)) {
    const { low, high } = subtreeRange(row.virtualPath);

    await db()
      .delete(filesMirror)
      .where(
        and(
          eq(filesMirror.accountId, accountId),
          gte(filesMirror.virtualPath, low),
          lt(filesMirror.virtualPath, high),
        ),
      );
  }

  await forgetFromMirror(accountId, remoteIds);
}

/**
 * Scanned per batch when a filter cannot be pushed into SQL.
 *
 * Category is the case: it falls back to the file extension when the mime type
 * is useless, which is a rule in TypeScript, not in the schema. Rows are read
 * in batches and filtered here until the page is full.
 */
const SCAN_BATCH = 4000;

export interface MirrorPage {
  files: OrbitFile[];
  nextCursor?: string | undefined;
  /** When this account was last synced, so a caller can say how old this is. */
  syncedAt: string | null;
}

/** A row offset, as an opaque string. Stable because the sort is deterministic. */
function readOffset(cursor: string | undefined): number {
  if (!cursor?.startsWith('m')) return 0;
  const offset = Number(cursor.slice(1));
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}

const writeOffset = (offset: number): string => `m${offset}`;

/**
 * The half-open range that holds everything under a folder.
 *
 * `LIKE 'prefix%'` cannot use the path index: SQLite's LIKE is
 * case-insensitive for ASCII, so the planner will not turn it into a range
 * scan. Comparing against the prefix and the prefix with its last byte
 * incremented is the same set of rows and does use the index.
 */
function subtreeRange(path: string): { low: string; high: string } {
  const low = path.endsWith('/') ? path : `${path}/`;
  const last = low.charCodeAt(low.length - 1);
  return { low, high: `${low.slice(0, -1)}${String.fromCharCode(last + 1)}` };
}

/** Maps a mirror row back to the shape every route already speaks. */
function toFile(row: typeof filesMirror.$inferSelect): OrbitFile {
  return {
    remoteId: row.remoteFileId,
    name: row.name,
    virtualPath: row.virtualPath,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    isFolder: row.isFolder,
    starred: row.starred,
    modifiedAt: row.modifiedAt ?? row.syncedAt,
    ...(row.createdAt ? { createdAt: row.createdAt } : {}),
    ...(row.checksum ? { checksum: row.checksum } : {}),
  };
}

/** Flips the starred flag on one row. Nothing else about the file moves. */
export async function starInMirror(
  accountId: string,
  remoteId: string,
  starred: boolean,
): Promise<void> {
  await db()
    .update(filesMirror)
    .set({ starred })
    .where(and(eq(filesMirror.accountId, accountId), eq(filesMirror.remoteFileId, remoteId)));
}

/**
 * Renames a row, and repairs everything underneath it.
 *
 * A folder's path is a prefix of every path below it, so renaming one and
 * stopping there leaves its whole subtree filed under a directory that no
 * longer exists - invisible when browsing, and still returned by search. The
 * children are rewritten in one statement rather than read and written back:
 * there may be fifty thousand of them.
 */
export async function renameInMirror(
  accountId: string,
  remoteId: string,
  name: string,
): Promise<void> {
  const [row] = await db()
    .select()
    .from(filesMirror)
    .where(and(eq(filesMirror.accountId, accountId), eq(filesMirror.remoteFileId, remoteId)));

  if (!row) return;

  const parent = row.virtualPath.slice(0, row.virtualPath.lastIndexOf('/'));
  const virtualPath = `${parent}/${name}`;

  if (row.isFolder) {
    const { low, high } = subtreeRange(row.virtualPath);

    await db()
      .update(filesMirror)
      .set({
        virtualPath: sql`${`${virtualPath}/`} || substr(${filesMirror.virtualPath}, ${low.length + 1})`,
      })
      .where(
        and(
          eq(filesMirror.accountId, accountId),
          gte(filesMirror.virtualPath, low),
          lt(filesMirror.virtualPath, high),
        ),
      );
  }

  await db()
    .update(filesMirror)
    .set({ name, virtualPath })
    .where(and(eq(filesMirror.accountId, accountId), eq(filesMirror.remoteFileId, remoteId)));
}

/**
 * Whether the mirror can answer for this account at all.
 *
 * An account that has never synced, or whose provider cannot be enumerated,
 * has no rows - and an empty folder and an unmirrored one look identical from
 * a query. So coverage is asked before the listing, and a miss falls through
 * to the provider rather than reporting a drive as empty.
 */
export async function mirrorCoverage(
  accountId: string,
): Promise<{ rows: number; syncedAt: string | null }> {
  const [[counted], [account]] = await Promise.all([
    db()
      .select({ rows: sql<number>`count(*)` })
      .from(filesMirror)
      .where(eq(filesMirror.accountId, accountId)),
    db()
      .select({ lastSyncedAt: accounts.lastSyncedAt })
      .from(accounts)
      .where(eq(accounts.id, accountId)),
  ]);

  return { rows: Number(counted?.rows ?? 0), syncedAt: account?.lastSyncedAt ?? null };
}

/**
 * One folder, from the mirror.
 *
 * Direct children only, which is what browsing means: everything under the
 * path, minus anything with a further separator in the part after it. Folders
 * sort ahead of files and then by name, the order a file manager uses and the
 * one the name index already provides.
 */
export async function listFolderFromMirror(
  accountId: string,
  path: string,
  cursor?: string,
): Promise<MirrorPage> {
  const { low, high } = subtreeRange(path);
  const offset = readOffset(cursor);

  const rows = await db()
    .select()
    .from(filesMirror)
    .where(
      and(
        eq(filesMirror.accountId, accountId),
        eq(filesMirror.trashed, false),
        gte(filesMirror.virtualPath, low),
        lt(filesMirror.virtualPath, high),
        sql`instr(substr(${filesMirror.virtualPath}, ${low.length + 1}), '/') = 0`,
      ),
    )
    .orderBy(desc(filesMirror.isFolder), asc(filesMirror.name))
    .limit(MIRROR_PAGE + 1)
    .offset(offset);

  const { syncedAt } = await mirrorCoverage(accountId);
  const more = rows.length > MIRROR_PAGE;

  return {
    files: rows.slice(0, MIRROR_PAGE).map(toFile),
    nextCursor: more ? writeOffset(offset + MIRROR_PAGE) : undefined,
    syncedAt,
  };
}

/** The filters that can be expressed in SQL, which is all of them but category. */
function filtersFor(request: SearchRequest): SQL[] {
  const where: SQL[] = [eq(filesMirror.trashed, false)];

  if (request.text?.trim()) {
    /*
     * FTS5 tokenises on non-word characters, so "report_2024.pdf" is three
     * tokens. Each term is matched as a prefix, which is what a search box
     * that filters as you type has to do - "repo" must find "report" before
     * the word is finished.
     *
     * Quoted because a term may contain characters FTS5 reads as operators;
     * an embedded quote is doubled, which is how FTS5 escapes one.
     */
    const match = request.text
      .trim()
      .split(/\s+/)
      .filter((term: string) => term.replace(/[^\p{L}\p{N}]/gu, '').length > 0)
      .map((term: string) => `"${term.replace(/"/g, '""')}"*`)
      .join(' ');

    if (match) {
      where.push(
        sql`${filesMirror.id} IN (
          SELECT m.id FROM files_fts f
          JOIN files_mirror m ON m.rowid = f.rowid
          WHERE files_fts MATCH ${match}
        )`,
      );
    }
  }

  if (request.starredOnly) where.push(eq(filesMirror.starred, true));
  if (request.modifiedAfter) where.push(gte(filesMirror.modifiedAt, request.modifiedAfter));
  if (request.modifiedBefore) where.push(lt(filesMirror.modifiedAt, request.modifiedBefore));

  if (request.underPath && request.underPath !== '/') {
    const { low, high } = subtreeRange(request.underPath);
    where.push(gte(filesMirror.virtualPath, low), lt(filesMirror.virtualPath, high));
  }

  /*
   * A null created date means the provider does not report one, so a created
   * filter must exclude those rows rather than treat them as the epoch. The
   * comparison does that on its own: SQL null compares false either way.
   */
  if (request.createdAfter) where.push(gte(filesMirror.createdAt, request.createdAfter));
  if (request.createdBefore) where.push(lt(filesMirror.createdAt, request.createdBefore));

  if (request.minSizeBytes !== undefined) {
    where.push(gte(filesMirror.sizeBytes, request.minSizeBytes));
  }
  if (request.maxSizeBytes !== undefined) {
    where.push(lt(filesMirror.sizeBytes, request.maxSizeBytes + 1));
  }

  return where;
}

/**
 * Search every readable account at once.
 *
 * The provider-backed search fans out and merges, because each account is a
 * separate service. Here they are rows in one table, so this is a single query
 * ordered by modified date - which also means the ordering is correct across
 * accounts rather than correct within each and merged afterwards.
 */
export async function searchMirror(
  request: SearchRequest,
  accountIds: string[],
  cursor?: string,
): Promise<SearchResultPage> {
  if (accountIds.length === 0) return { files: [], problems: [], unsupported: [] };

  const scoped = request.accountId
    ? accountIds.filter((id) => id === request.accountId)
    : accountIds;
  if (scoped.length === 0) return { files: [], problems: [], unsupported: [] };

  const categories = new Set((request.categories ?? []) as FileCategory[]);
  const where = and(inArray(filesMirror.accountId, scoped), ...filtersFor(request));

  const files: WorkspaceFile[] = [];
  let offset = readOffset(cursor);
  let exhausted = false;

  /*
   * Category cannot go into the query, so rows are read in batches and
   * filtered here until the page is full. The cursor counts rows *scanned*,
   * not rows kept, so continuing never re-reads or skips.
   */
  while (files.length < MIRROR_PAGE && !exhausted) {
    const rows = await db()
      .select({ file: filesMirror, provider: accounts.provider, nickname: accounts.nickname })
      .from(filesMirror)
      .innerJoin(accounts, eq(accounts.id, filesMirror.accountId))
      .where(where)
      .orderBy(desc(filesMirror.modifiedAt), asc(filesMirror.id))
      .limit(SCAN_BATCH)
      .offset(offset);

    if (rows.length < SCAN_BATCH) exhausted = true;
    offset += rows.length;

    for (const row of rows) {
      const file = toFile(row.file);

      // Folders match by name like anything else, but a category filter is
      // about content, so it excludes them.
      if (categories.size > 0) {
        if (file.isFolder) continue;
        if (!categories.has(categorise(file.mimeType, file.name))) continue;
      }

      files.push({
        ...file,
        accountId: row.file.accountId,
        provider: row.provider,
        accountNickname: row.nickname,
      });

      if (files.length >= MIRROR_PAGE) break;
    }
  }

  return {
    files,
    problems: [],
    unsupported: [],
    nextCursor: exhausted && files.length < MIRROR_PAGE ? undefined : writeOffset(offset),
  };
}

export type SearchResultPage = ViewResult;
