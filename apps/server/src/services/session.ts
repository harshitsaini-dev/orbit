import { randomBytes } from 'node:crypto';
import { sessions, users } from '@orbit/db';
import type { PublicUser } from '@orbit/shared-types';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { CookieOptions, Response } from 'express';
import { nanoid } from 'nanoid';
import { db } from '../lib/db.js';
import { env } from '../lib/env.js';
import { tokenFingerprint } from '../lib/hash.js';

export const SESSION_COOKIE = 'orbit_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionContext {
  user: PublicUser;
  sessionId: string;
}

function cookieOptions(expires: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    /*
     * lax, not strict.
     *
     * The frontend and the API share a registrable domain, so the SPA's own
     * fetches are same-site either way. What strict also refuses is a
     * *top-level navigation* arriving from another site - and that is exactly
     * how an OAuth callback comes back: Google sends the browser to
     * /auth/callback/:provider, the cookie is withheld, and connecting a drive
     * ends at "Sign in to continue" for somebody who is signed in.
     *
     * lax sends the cookie on a top-level GET and still withholds it on a
     * cross-site POST, which is the case CSRF actually needs. The OAuth state
     * cookie has been lax for this same reason since it was written.
     */
    sameSite: 'lax',
    domain: env.COOKIE_DOMAIN,
    path: '/',
    expires,
  };
}

export function toPublicUser(row: typeof users.$inferSelect): PublicUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    avatar: row.avatar,
    role: row.role,
    theme: row.theme,
    accent: row.accent,
    allocationStrategy: row.allocationStrategy,
    createdAt: row.createdAt,
  };
}

/** Returns the raw token; only its fingerprint is stored. */
export async function createSession(
  userId: string,
  meta: { ip?: string; userAgent?: string } = {},
  now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  await db().insert(sessions).values({
    id: nanoid(),
    userId,
    tokenHash: tokenFingerprint(token),
    ip: meta.ip ?? null,
    userAgent: meta.userAgent?.slice(0, 255) ?? null,
    expiresAt: expiresAt.toISOString(),
    createdAt: now.toISOString(),
  });

  // Signing in is what turns an invited address into a person who has actually
  // turned up, which is the difference a member list has to show.
  await db().update(users).set({ lastSeenAt: now.toISOString() }).where(eq(users.id, userId));

  return { token, expiresAt };
}

export async function resolveSession(token: string, now = new Date()): Promise<SessionContext | null> {
  const [row] = await db()
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenFingerprint(token)), gt(sessions.expiresAt, now.toISOString())))
    .limit(1);

  if (!row) return null;
  return { user: toPublicUser(row.user), sessionId: row.session.id };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await db().delete(sessions).where(eq(sessions.id, sessionId));
}

export async function revokeAllSessionsFor(userId: string): Promise<void> {
  await db().delete(sessions).where(eq(sessions.userId, userId));
}

export async function purgeExpiredSessions(now = new Date()): Promise<void> {
  await db().delete(sessions).where(lt(sessions.expiresAt, now.toISOString()));
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(SESSION_COOKIE, token, cookieOptions(expiresAt));
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions(new Date(0)), expires: undefined });
}
