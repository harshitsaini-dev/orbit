import { accounts, auditLog, sessions, shareLinks, users } from '@orbit/db';
import { and, count, desc, eq, gt, isNull, sum } from 'drizzle-orm';
import { db } from '../lib/db.js';

/**
 * What the person running this instance can see.
 *
 * Deliberately about the instance rather than about anybody's files. A
 * superadmin can see that somebody has four accounts and 30 GB in them; they
 * cannot browse those accounts, read those files, or see what is in them. The
 * distinction matters because Orbit's whole promise is that it holds nothing -
 * an admin console that quietly walked around that would make the promise
 * false, and the operator is the one person best placed to break it.
 *
 * So the only actions here are the two an operator genuinely needs: making
 * somebody else an admin, and removing an account that should not exist.
 */

export interface AdminOverview {
  users: number;
  accounts: number;
  shares: number;
  activeSessions: number;
  /** As each provider reports it, summed. Not files Orbit holds - it holds none. */
  storedBytes: number;
}

export async function overview(): Promise<AdminOverview> {
  const now = new Date().toISOString();

  const [[userCount], [accountCount], [shareCount], [sessionCount], [stored]] = await Promise.all([
    db().select({ value: count() }).from(users),
    db().select({ value: count() }).from(accounts),
    // isNull, not eq(..., null): `= NULL` is never true in SQL, so that would
    // have reported no live links for ever without failing.
    db().select({ value: count() }).from(shareLinks).where(isNull(shareLinks.revokedAt)),
    db().select({ value: count() }).from(sessions).where(gt(sessions.expiresAt, now)),
    db().select({ value: sum(accounts.usedBytes) }).from(accounts),
  ]);

  return {
    users: userCount?.value ?? 0,
    accounts: accountCount?.value ?? 0,
    shares: shareCount?.value ?? 0,
    activeSessions: sessionCount?.value ?? 0,
    storedBytes: Number(stored?.value ?? 0),
  };
}

export interface AdminUser {
  id: string;
  email: string;
  displayName: string | null;
  role: 'user' | 'superadmin';
  accounts: number;
  /** Null for somebody who was invited to a drive and never signed in. */
  lastSeenAt: string | null;
  createdAt: string;
}

export async function listUsers(): Promise<AdminUser[]> {
  const rows = await db()
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      lastSeenAt: users.lastSeenAt,
      createdAt: users.createdAt,
      accounts: count(accounts.id),
    })
    .from(users)
    // Left, so somebody with no connected drive still appears - that is most
    // of the interesting cases: invited and never arrived, or signed up and
    // stopped.
    .leftJoin(accounts, eq(accounts.userId, users.id))
    .groupBy(users.id)
    .orderBy(desc(users.createdAt));

  return rows.map((row) => ({ ...row, role: row.role }));
}

export type RoleChange =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'self' | 'last_admin' };

/**
 * Promotes or demotes somebody.
 *
 * Two refusals, both about locking the instance out of itself: nobody may
 * change their own role, and the last superadmin may not be demoted. An
 * instance with no administrator has no way back short of editing the database
 * by hand.
 */
export async function setRole(
  actorId: string,
  userId: string,
  role: 'user' | 'superadmin',
): Promise<RoleChange> {
  if (actorId === userId) return { ok: false, reason: 'self' };

  const [target] = await db().select().from(users).where(eq(users.id, userId)).limit(1);
  if (!target) return { ok: false, reason: 'not_found' };

  if (target.role === 'superadmin' && role === 'user') {
    const [admins] = await db()
      .select({ value: count() })
      .from(users)
      .where(eq(users.role, 'superadmin'));

    if ((admins?.value ?? 0) <= 1) return { ok: false, reason: 'last_admin' };
  }

  await db().update(users).set({ role }).where(eq(users.id, userId));
  return { ok: true };
}

export type Removal = { ok: true } | { ok: false; reason: 'not_found' | 'self' | 'last_admin' };

/**
 * Removes a user and everything of theirs.
 *
 * Their connected accounts, sessions and collections cascade away with them.
 * Their audit entries do not: the actor id nulls instead, so what was done on a
 * shared drive still reads as having happened, with the name gone.
 */
export async function removeUser(actorId: string, userId: string): Promise<Removal> {
  if (actorId === userId) return { ok: false, reason: 'self' };

  const [target] = await db().select().from(users).where(eq(users.id, userId)).limit(1);
  if (!target) return { ok: false, reason: 'not_found' };

  if (target.role === 'superadmin') {
    const [admins] = await db()
      .select({ value: count() })
      .from(users)
      .where(eq(users.role, 'superadmin'));

    if ((admins?.value ?? 0) <= 1) return { ok: false, reason: 'last_admin' };
  }

  await db().delete(users).where(eq(users.id, userId));
  return { ok: true };
}

export interface AdminEvent {
  id: string;
  action: string;
  actorEmail: string | null;
  summary: string | null;
  createdAt: string;
}

/** The whole instance's trail, newest first. */
export async function recentActivity(limit = 100): Promise<AdminEvent[]> {
  const rows = await db()
    .select({
      id: auditLog.id,
      action: auditLog.action,
      actorEmail: auditLog.actorEmail,
      currentEmail: users.email,
      summary: auditLog.summary,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .orderBy(desc(auditLog.createdAt))
    .limit(Math.min(limit, 200));

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    actorEmail: row.currentEmail ?? row.actorEmail,
    summary: row.summary,
    createdAt: row.createdAt,
  }));
}

/** Sessions that have not expired, so an operator can see who is currently in. */
export async function activeSessions(): Promise<
  Array<{ email: string; ip: string | null; userAgent: string | null; createdAt: string }>
> {
  const rows = await db()
    .select({
      email: users.email,
      ip: sessions.ip,
      userAgent: sessions.userAgent,
      createdAt: sessions.createdAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(gt(sessions.expiresAt, new Date().toISOString())))
    .orderBy(desc(sessions.createdAt))
    .limit(100);

  return rows;
}
