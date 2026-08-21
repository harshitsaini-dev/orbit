import { users } from '@orbit/db';
import type { PublicUser, SystemRole } from '@orbit/shared-types';
import { eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../lib/db.js';
import { toPublicUser } from './session.js';

export const LOCAL_USER_EMAIL = 'local@orbit.local';

export async function findByEmail(email: string): Promise<PublicUser | null> {
  const [row] = await db()
    .select()
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  return row ? toPublicUser(row) : null;
}

export async function findById(id: string): Promise<PublicUser | null> {
  const [row] = await db().select().from(users).where(eq(users.id, id)).limit(1);
  return row ? toPublicUser(row) : null;
}

/**
 * Sign-in is registration - there is no separate signup step in an OTP flow.
 * The very first account to exist becomes superadmin, so a fresh deployment is
 * never left without an administrator.
 */
export async function findOrCreateByEmail(email: string): Promise<PublicUser> {
  const address = email.trim().toLowerCase();

  const existing = await findByEmail(address);
  if (existing) return existing;

  const [tally] = await db().select({ count: sql<number>`count(*)` }).from(users);
  const role: SystemRole = (tally?.count ?? 0) === 0 ? 'superadmin' : 'user';

  const [created] = await db()
    .insert(users)
    .values({ id: nanoid(), email: address, role })
    .returning();

  if (!created) throw new Error('Failed to create user');
  return toPublicUser(created);
}

/** Local mode runs as a single implicit user; no OTP, no cookie. */
export async function getLocalUser(): Promise<PublicUser> {
  return findOrCreateByEmail(LOCAL_USER_EMAIL);
}
