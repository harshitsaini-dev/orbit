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

/**
 * Fills in a name and picture from a newly connected provider, but only where
 * the profile has none — a provider must never overwrite something the user set
 * themselves.
 *
 * The picture is fetched here and stored as a data URL rather than kept as the
 * provider's link. A remote URL in the page would tell the provider every time
 * the user loads Orbit, and would break the moment the account is disconnected.
 */
export async function seedProfileFrom(
  userId: string,
  identity: { displayName?: string; photoUrl?: string },
): Promise<void> {
  const [row] = await db().select().from(users).where(eq(users.id, userId)).limit(1);
  if (!row) return;

  const update: { displayName?: string; avatar?: string } = {};

  if (!row.displayName && identity.displayName) {
    update.displayName = identity.displayName.slice(0, 80);
  }

  if (!row.avatar && identity.photoUrl) {
    const avatar = await fetchAvatar(identity.photoUrl);
    if (avatar) update.avatar = avatar;
  }

  if (Object.keys(update).length > 0) {
    await db().update(users).set(update).where(eq(users.id, userId));
  }
}

const AVATAR_MAX_BYTES = 256 * 1024;

async function fetchAvatar(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;

    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > AVATAR_MAX_BYTES) return null;

    return `data:${type};base64,${buffer.toString('base64')}`;
  } catch {
    // A missing picture is not a reason to fail the connection.
    return null;
  }
}

/** Local mode runs as a single implicit user; no OTP, no cookie. */
export async function getLocalUser(): Promise<PublicUser> {
  return findOrCreateByEmail(LOCAL_USER_EMAIL);
}
