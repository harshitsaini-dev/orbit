import { accounts, filesMirror } from '@orbit/db';
import { eq } from 'drizzle-orm';
import { db } from '../lib/db.js';

/**
 * The same file, in more than one place.
 *
 * Reads the mirror rather than the providers: comparing every file in every
 * account against every other would be thousands of requests, and the mirror
 * already holds exactly the three things needed - a checksum where there is
 * one, a size, and a name.
 *
 * The honesty problem here is bigger than the algorithm. Checksums are not
 * comparable across providers as often as one would like, so a match found by
 * size and name is a guess, and presenting a guess as a certainty is how
 * somebody deletes their only copy. Every group says which it is.
 */

/**
 * How sure we are that two files are the same.
 *
 * `identical` means both sides published a checksum and they agree. Nothing
 * else is more than a strong hint.
 */
export type MatchKind = 'identical' | 'probable';

export interface DuplicateFile {
  accountId: string;
  accountNickname: string;
  provider: string;
  catalogueKey: string | null;
  remoteId: string;
  name: string;
  virtualPath: string;
  sizeBytes: number;
  modifiedAt: string | null;
}

export interface DuplicateGroup {
  kind: MatchKind;
  /** The checksum, for an identical group. Absent for a probable one. */
  checksum?: string;
  sizeBytes: number;
  files: DuplicateFile[];
  /** What deleting all but one would free. */
  reclaimableBytes: number;
}

/**
 * Files below this are excluded whatever they match on.
 *
 * A thousand empty files and a hundred identical 12-byte configs are not what
 * anyone means by duplicates, and they would bury the ones that matter.
 */
const MIN_SIZE = 64 * 1024;

/**
 * A multipart ETag is not a hash of the content.
 *
 * S3 builds it from the hashes of the parts and appends the part count, so two
 * identical files uploaded with different part sizes get different ETags, and
 * two different files could in principle collide. It is not comparable with
 * anything, including another multipart ETag.
 */
function comparableChecksum(checksum: string | null): string | null {
  if (!checksum) return null;
  const cleaned = checksum.replace(/"/g, '').trim().toLowerCase();
  if (cleaned === '' || cleaned.includes('-')) return null;
  return cleaned;
}

export async function findDuplicates(
  userId: string,
  options: { minSizeBytes?: number } = {},
): Promise<{ groups: DuplicateGroup[]; scanned: number; withoutChecksum: number }> {
  const minSize = options.minSizeBytes ?? MIN_SIZE;

  const rows = await db()
    .select({
      accountId: filesMirror.accountId,
      nickname: accounts.nickname,
      provider: accounts.provider,
      catalogueKey: accounts.catalogueKey,
      remoteId: filesMirror.remoteFileId,
      name: filesMirror.name,
      virtualPath: filesMirror.virtualPath,
      sizeBytes: filesMirror.sizeBytes,
      checksum: filesMirror.checksum,
      isFolder: filesMirror.isFolder,
      modifiedAt: filesMirror.modifiedAt,
    })
    .from(filesMirror)
    .innerJoin(accounts, eq(accounts.id, filesMirror.accountId))
    .where(eq(accounts.userId, userId));

  const files = rows.filter((row) => !row.isFolder && row.sizeBytes >= minSize);

  const byChecksum = new Map<string, typeof files>();
  const bySizeAndName = new Map<string, typeof files>();
  let withoutChecksum = 0;

  for (const row of files) {
    const checksum = comparableChecksum(row.checksum);

    if (checksum) {
      const key = `${checksum}:${row.sizeBytes}`;
      byChecksum.set(key, [...(byChecksum.get(key) ?? []), row]);
    } else {
      withoutChecksum += 1;
    }

    // Every file is also grouped by size and name, including ones with a
    // checksum: a Drive file and a bucket object can be the same file while
    // their hashes are not comparable with each other.
    const weak = `${row.sizeBytes}:${row.name.toLowerCase()}`;
    bySizeAndName.set(weak, [...(bySizeAndName.get(weak) ?? []), row]);
  }

  const toFile = (row: (typeof files)[number]): DuplicateFile => ({
    accountId: row.accountId,
    accountNickname: row.nickname,
    provider: row.provider,
    catalogueKey: row.catalogueKey,
    remoteId: row.remoteId,
    name: row.name,
    virtualPath: row.virtualPath,
    sizeBytes: row.sizeBytes,
    modifiedAt: row.modifiedAt,
  });

  const groups: DuplicateGroup[] = [];
  /** Files already reported as certain, so they are not reported again as a guess. */
  const claimed = new Set<string>();

  for (const [key, matches] of byChecksum) {
    if (matches.length < 2) continue;

    for (const match of matches) claimed.add(`${match.accountId}:${match.remoteId}`);

    groups.push({
      kind: 'identical',
      checksum: key.split(':')[0]!,
      sizeBytes: matches[0]!.sizeBytes,
      files: matches.map(toFile),
      reclaimableBytes: matches[0]!.sizeBytes * (matches.length - 1),
    });
  }

  for (const matches of bySizeAndName.values()) {
    if (matches.length < 2) continue;

    // Only the ones not already proven identical. A group reduced to a single
    // file by this is not a duplicate at all.
    const unclaimed = matches.filter(
      (match) => !claimed.has(`${match.accountId}:${match.remoteId}`),
    );
    if (unclaimed.length < 2) continue;

    groups.push({
      kind: 'probable',
      sizeBytes: unclaimed[0]!.sizeBytes,
      files: unclaimed.map(toFile),
      reclaimableBytes: unclaimed[0]!.sizeBytes * (unclaimed.length - 1),
    });
  }

  // Biggest saving first: that is the order anyone reading this list wants.
  groups.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);

  return { groups, scanned: files.length, withoutChecksum };
}
