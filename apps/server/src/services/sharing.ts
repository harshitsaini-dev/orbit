import { accountGrants, accounts, users } from '@orbit/db';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../lib/db.js';
import { findOrCreateByEmail } from './users.js';

/**
 * Letting other people use a connected drive.
 *
 * The unit is one drive, not the whole Orbit account. Somebody brought in to
 * work on the team bucket has no business seeing the personal Drive connected
 * next to it, and a model that only knows "is a member" cannot express that.
 *
 * Members sign in as themselves — their own address, their own code, their own
 * session. Nothing is shared but the drive, so revoking a grant takes the
 * access away without touching how they get in, and the audit trail names a
 * person rather than an account that several people happen to use.
 */

/** Ordered, least to most. Every level contains the ones before it. */
export const LEVELS = ['read', 'write', 'full', 'admin'] as const;
export type Level = (typeof LEVELS)[number];

/**
 * What a request needs to be allowed.
 *
 * `manage` is deliberately not a level of its own: it is what `admin` permits,
 * named for the thing being done rather than for who may do it.
 */
export type Need = 'read' | 'write' | 'delete' | 'share' | 'manage';

const REQUIRED: Record<Need, Level> = {
  read: 'read',
  write: 'write',
  // Deleting and publishing a link both put a file somewhere it cannot be
  // pulled back from, so they sit together above ordinary writing.
  delete: 'full',
  share: 'full',
  manage: 'admin',
};

export function levelAllows(level: Level, need: Need): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(REQUIRED[need]);
}

export interface Access {
  /** Who the drive belongs to. Tokens and quota are still theirs. */
  ownerId: string;
  /** True when the caller is that owner rather than a guest. */
  isOwner: boolean;
  level: Level;
}

/**
 * What this user may do with this drive, or null if they may not know it
 * exists.
 *
 * The owner is not given a grant row — they would then be a guest on their own
 * connection, and a bug that deleted grants would lock them out of it.
 */
export async function accessTo(userId: string, accountId: string): Promise<Access | null> {
  const [account] = await db()
    .select({ ownerId: accounts.userId })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  if (!account) return null;
  if (account.ownerId === userId) return { ownerId: userId, isOwner: true, level: 'admin' };

  const [grant] = await db()
    .select({ level: accountGrants.level })
    .from(accountGrants)
    .where(and(eq(accountGrants.accountId, accountId), eq(accountGrants.userId, userId)))
    .limit(1);

  if (!grant) return null;
  return { ownerId: account.ownerId, isOwner: false, level: grant.level };
}

/** Every drive id this user may see, whether their own or granted. */
export async function readableAccountIds(userId: string): Promise<string[]> {
  const [own, granted] = await Promise.all([
    db().select({ id: accounts.id }).from(accounts).where(eq(accounts.userId, userId)),
    db()
      .select({ id: accountGrants.accountId })
      .from(accountGrants)
      .where(eq(accountGrants.userId, userId)),
  ]);

  return [...own.map((r) => r.id), ...granted.map((r) => r.id)];
}

export interface Member {
  userId: string;
  email: string;
  displayName: string | null;
  avatar: string | null;
  level: Level;
  /** Null until they have signed in for the first time. */
  joinedAt: string | null;
  invitedAt: string;
}

export async function listMembers(accountId: string): Promise<Member[]> {
  const rows = await db()
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      avatar: users.avatar,
      level: accountGrants.level,
      invitedAt: accountGrants.createdAt,
      lastSeenAt: users.lastSeenAt,
    })
    .from(accountGrants)
    .innerJoin(users, eq(users.id, accountGrants.userId))
    .where(eq(accountGrants.accountId, accountId));

  return rows.map((row) => ({
    userId: row.userId,
    email: row.email,
    displayName: row.displayName,
    avatar: row.avatar,
    level: row.level,
    joinedAt: row.lastSeenAt,
    invitedAt: row.invitedAt,
  }));
}

export type InviteResult =
  | { ok: true; member: Member }
  | { ok: false; reason: 'owner' | 'self' };

/**
 * Adds somebody to a drive, creating their account if this is the first time
 * anyone has named them.
 *
 * No invitation token and no accept step. The address is the claim, and signing
 * in with a code sent to it is what proves the claim — a token in a link proves
 * only that somebody has the link.
 */
export async function invite(input: {
  accountId: string;
  ownerId: string;
  grantedBy: string;
  email: string;
  level: Level;
}): Promise<InviteResult> {
  const email = input.email.trim().toLowerCase();
  const user = await findOrCreateByEmail(email);

  if (user.id === input.ownerId) return { ok: false, reason: 'owner' };
  if (user.id === input.grantedBy) return { ok: false, reason: 'self' };

  await db()
    .insert(accountGrants)
    .values({
      id: nanoid(),
      accountId: input.accountId,
      userId: user.id,
      level: input.level,
      grantedBy: input.grantedBy,
    })
    // Inviting somebody who is already here is a change of level, not an
    // error: it is what the button does when you get the level wrong first.
    .onConflictDoUpdate({
      target: [accountGrants.accountId, accountGrants.userId],
      set: { level: input.level, grantedBy: input.grantedBy },
    });

  const members = await listMembers(input.accountId);
  const member = members.find((m) => m.userId === user.id)!;
  return { ok: true, member };
}

export async function setLevel(
  accountId: string,
  userId: string,
  level: Level,
): Promise<boolean> {
  const [row] = await db()
    .update(accountGrants)
    .set({ level })
    .where(and(eq(accountGrants.accountId, accountId), eq(accountGrants.userId, userId)))
    .returning();

  return Boolean(row);
}

export async function revoke(accountId: string, userId: string): Promise<boolean> {
  const [row] = await db()
    .delete(accountGrants)
    .where(and(eq(accountGrants.accountId, accountId), eq(accountGrants.userId, userId)))
    .returning();

  return Boolean(row);
}
