import { shareLinks } from '@orbit/db';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { customAlphabet } from 'nanoid';
import { db } from '../lib/db.js';
import { hashSecret, verifySecret } from '../lib/hash.js';
import { useAccount } from './accounts.js';

/**
 * Public links to single files.
 *
 * The provider's URL, the account and the file's remote id never reach the
 * browser. A visitor gets an Orbit address, and Orbit streams the bytes from
 * the adapter — which is the whole reason the proxy exists, and the reason
 * embedding a provider's own viewer was never an option.
 */

/**
 * Twelve characters from an unambiguous alphabet.
 *
 * No 0/O or 1/l/I, because these get read aloud and typed from a QR code that
 * would not scan. Twelve of 32 is 60 bits - not guessable, and short enough to
 * be a link rather than a paragraph.
 */
const newShortId = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 12);

export interface PublicShare {
  shortId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  permission: 'view' | 'download';
  hasPassword: boolean;
  expiresAt: string | null;
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string;
  /** Which account holds it. The provider's own id is deliberately absent. */
  accountId: string;
}

type ShareRow = typeof shareLinks.$inferSelect;

function toPublicShare(row: ShareRow): PublicShare {
  return {
    shortId: row.shortId,
    name: row.name,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    permission: row.permission,
    // The hash itself is never returned; whether there is one is not a secret.
    hasPassword: row.passwordHash !== null,
    expiresAt: row.expiresAt,
    accessCount: row.accessCount,
    lastAccessedAt: row.lastAccessedAt,
    createdAt: row.createdAt,
    accountId: row.accountId,
  };
}

export interface CreateShareInput {
  userId: string;
  accountId: string;
  remoteId: string;
  permission?: 'view' | 'download';
  password?: string | undefined;
  expiresInDays?: number | undefined;
}

/**
 * Creates a link, or returns the one that already exists for this file.
 *
 * Sharing the same file twice is a normal thing to do — usually because the
 * first link was lost — and minting a second would leave the first live and
 * unrevokable from the UI, since only one can be shown per file.
 */
export async function createShare(input: CreateShareInput): Promise<PublicShare | null> {
  const active = await useAccount(input.userId, input.accountId, 'share');
  if (!active) return null;

  // The snapshot has to come from the provider: it is what the public page
  // shows, and reading it per view would let a link make Orbit hammer a Drive.
  const file = await active.adapter.getFileMeta(active.tokens, input.remoteId);

  const [existing] = await db()
    .select()
    .from(shareLinks)
    .where(
      and(
        eq(shareLinks.ownerId, input.userId),
        eq(shareLinks.accountId, input.accountId),
        eq(shareLinks.remoteId, input.remoteId),
        isNull(shareLinks.revokedAt),
      ),
    )
    .limit(1);

  const expiresAt =
    input.expiresInDays === undefined
      ? null
      : new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString();

  const passwordHash = input.password ? await hashSecret(input.password) : null;

  if (existing) {
    const [updated] = await db()
      .update(shareLinks)
      .set({
        // Refreshed, since the file may have been renamed since.
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        permission: input.permission ?? existing.permission,
        expiresAt,
        // An omitted password leaves the existing one alone rather than
        // silently unlocking a link that was protected.
        ...(input.password === undefined ? {} : { passwordHash }),
      })
      .where(eq(shareLinks.shortId, existing.shortId))
      .returning();

    return updated ? toPublicShare(updated) : null;
  }

  const [created] = await db()
    .insert(shareLinks)
    .values({
      shortId: newShortId(),
      ownerId: input.userId,
      accountId: input.accountId,
      remoteId: input.remoteId,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      permission: input.permission ?? 'download',
      passwordHash,
      expiresAt,
    })
    .returning();

  return created ? toPublicShare(created) : null;
}

/** The live link for one file, if there is one. */
export async function findShare(
  userId: string,
  accountId: string,
  remoteId: string,
): Promise<PublicShare | null> {
  const [row] = await db()
    .select()
    .from(shareLinks)
    .where(
      and(
        eq(shareLinks.ownerId, userId),
        eq(shareLinks.accountId, accountId),
        eq(shareLinks.remoteId, remoteId),
        isNull(shareLinks.revokedAt),
      ),
    )
    .limit(1);

  return row ? toPublicShare(row) : null;
}

/**
 * Which of these files have a live link, for one account.
 *
 * A set rather than the links themselves: a listing needs to mark the shared
 * ones, not describe how each is shared, and returning the links would put
 * every short id on the client for a page that shows none of them.
 *
 * One query for the whole page. Asking per file would be a query per row.
 */
export async function sharedRemoteIds(
  userId: string,
  accountId: string,
  remoteIds: string[],
): Promise<Set<string>> {
  if (remoteIds.length === 0) return new Set();

  const rows = await db()
    .select({ remoteId: shareLinks.remoteId })
    .from(shareLinks)
    .where(
      and(
        eq(shareLinks.ownerId, userId),
        eq(shareLinks.accountId, accountId),
        isNull(shareLinks.revokedAt),
        inArray(shareLinks.remoteId, remoteIds),
      ),
    );

  return new Set(rows.map((row) => row.remoteId));
}

export async function listShares(userId: string): Promise<PublicShare[]> {
  const rows = await db()
    .select()
    .from(shareLinks)
    .where(and(eq(shareLinks.ownerId, userId), isNull(shareLinks.revokedAt)))
    .orderBy(desc(shareLinks.createdAt));

  return rows.map(toPublicShare);
}

/**
 * Revokes rather than deletes.
 *
 * A revoked link keeps its short id, so the same id can never be handed out
 * again to something else - and the owner can still see that it existed.
 */
/**
 * Revokes a link and returns the row, or null if there was nothing to revoke.
 *
 * The row rather than a boolean because the caller needs to know which drive it
 * belonged to - a revocation is recorded against the drive, and the link is the
 * only thing that knows which one that was.
 */
export async function revokeShare(
  userId: string,
  shortId: string,
): Promise<{ accountId: string } | null> {
  const [updated] = await db()
    .update(shareLinks)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(eq(shareLinks.shortId, shortId), eq(shareLinks.ownerId, userId)))
    .returning();

  return updated ? { accountId: updated.accountId } : null;
}

export type ShareLookup =
  | { state: 'missing' }
  | { state: 'expired' }
  | { state: 'locked'; share: PublicShare }
  | { state: 'open'; share: PublicShare; row: ShareRow };

/**
 * Resolves a link for a visitor.
 *
 * A revoked link and one that never existed give the same answer, so the id
 * space cannot be probed for links that used to work. Expiry is told apart,
 * because "this link has expired" is useful and reveals nothing a visitor who
 * already had the link did not know.
 */
export async function lookupShare(shortId: string, password?: string): Promise<ShareLookup> {
  const [row] = await db().select().from(shareLinks).where(eq(shareLinks.shortId, shortId)).limit(1);

  if (!row || row.revokedAt) return { state: 'missing' };

  if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) {
    return { state: 'expired' };
  }

  if (row.passwordHash) {
    if (password === undefined) return { state: 'locked', share: toPublicShare(row) };
    if (!(await verifySecret(password, row.passwordHash))) {
      return { state: 'locked', share: toPublicShare(row) };
    }
  }

  return { state: 'open', share: toPublicShare(row), row };
}

/** Counted after the bytes are served, so a failed fetch is not an access. */
export async function recordAccess(shortId: string): Promise<void> {
  const [row] = await db()
    .select({ count: shareLinks.accessCount })
    .from(shareLinks)
    .where(eq(shareLinks.shortId, shortId))
    .limit(1);

  if (!row) return;

  await db()
    .update(shareLinks)
    .set({ accessCount: row.count + 1, lastAccessedAt: new Date().toISOString() })
    .where(eq(shareLinks.shortId, shortId));
}

export interface ShareTarget {
  ownerId: string;
  accountId: string;
  remoteId: string;
  name: string;
  permission: 'view' | 'download';
}

/**
 * What the bytes route needs, for a link that may be password protected.
 *
 * `unlocked` stands in for the password: the page has already checked it, and
 * the cookie it set is the proof. Without this the content request would have
 * to ask for the password again, which for a `<video>` element means it simply
 * fails.
 */
export async function resolveShareTarget(
  shortId: string,
  unlocked: boolean,
): Promise<ShareTarget | { blocked: 'missing' | 'expired' | 'locked' }> {
  const [row] = await db().select().from(shareLinks).where(eq(shareLinks.shortId, shortId)).limit(1);

  if (!row || row.revokedAt) return { blocked: 'missing' };
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) {
    return { blocked: 'expired' };
  }
  if (row.passwordHash && !unlocked) return { blocked: 'locked' };

  return {
    ownerId: row.ownerId,
    accountId: row.accountId,
    remoteId: row.remoteId,
    name: row.name,
    permission: row.permission,
  };
}
