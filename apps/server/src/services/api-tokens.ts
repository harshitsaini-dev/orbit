import { randomBytes } from 'node:crypto';
import { apiTokens, users } from '@orbit/db';
import {
  isApiScope,
  TOKEN_PREFIX,
  type ApiScope,
  type PublicApiToken,
  type PublicUser,
} from '@orbit/shared-types';
import { and, eq, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../lib/db.js';
import { tokenFingerprint } from '../lib/hash.js';
import { toPublicUser } from './session.js';

/**
 * Personal access tokens: somebody acting as themselves, from a script.
 *
 * Same storage as a session - a SHA-256 fingerprint, never the token itself -
 * so this table leaking is not the same as the tokens leaking. The value is
 * returned exactly once, at creation, and cannot be recovered afterwards.
 */

/** 32 random bytes, base64url, behind the prefix a scanner can find. */
function mint(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

function toPublicToken(row: typeof apiTokens.$inferSelect): PublicApiToken {
  return {
    id: row.id,
    name: row.name,
    tail: row.tail,
    scopes: row.scopes.split(' ').filter(isApiScope),
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

export interface CreatedToken {
  /** The only time this is ever available. */
  token: string;
  record: PublicApiToken;
}

export async function createToken(input: {
  userId: string;
  name: string;
  scopes: ApiScope[];
  expiresAt?: Date | undefined;
}): Promise<CreatedToken> {
  const token = mint();
  const now = new Date();

  const row: typeof apiTokens.$inferInsert = {
    id: nanoid(),
    userId: input.userId,
    name: input.name.slice(0, 80),
    tokenHash: tokenFingerprint(token),
    // Enough to recognise, far too little to reconstruct.
    tail: token.slice(-6),
    scopes: input.scopes.join(' '),
    expiresAt: input.expiresAt?.toISOString() ?? null,
    createdAt: now.toISOString(),
  };

  await db().insert(apiTokens).values(row);

  return { token, record: toPublicToken({ ...row, lastUsedAt: null, revokedAt: null } as typeof apiTokens.$inferSelect) };
}

export async function listTokens(userId: string): Promise<PublicApiToken[]> {
  const rows = await db()
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)));

  return rows
    .map(toPublicToken)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * Revoked rather than deleted.
 *
 * The row is what a later audit reads to say a token existed and when it
 * stopped working; deleting it would leave requests in the log attributed to
 * something that appears never to have been issued.
 */
export async function revokeToken(userId: string, id: string): Promise<boolean> {
  const result = await db()
    .update(apiTokens)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)));

  return (result.rowsAffected ?? 0) > 0;
}

export interface TokenContext {
  user: PublicUser;
  tokenId: string;
  scopes: ApiScope[];
}

/** How stale `last_used_at` is allowed to be. See the schema for why. */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * The token behind a request, or null for anything that is not a live one.
 *
 * Every rejection returns the same null: expired, revoked, never existed, or
 * the wrong shape entirely. A caller cannot learn which from the outside, and
 * there is nothing a client could do differently for any of them.
 */
export async function resolveToken(raw: string, now = new Date()): Promise<TokenContext | null> {
  // Checked before the query: a credential without the prefix is not one of
  // ours, and there is no reason to ask the database about it.
  if (!raw.startsWith(TOKEN_PREFIX)) return null;

  const [row] = await db()
    .select({ token: apiTokens, user: users })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(eq(apiTokens.tokenHash, tokenFingerprint(raw)))
    .limit(1);

  if (!row) return null;
  if (row.token.revokedAt) return null;
  if (row.token.expiresAt && row.token.expiresAt <= now.toISOString()) return null;

  const last = row.token.lastUsedAt ? Date.parse(row.token.lastUsedAt) : 0;
  if (now.getTime() - last > TOUCH_INTERVAL_MS) {
    // Not awaited: whether a token was used a second ago or a minute ago is
    // not worth delaying the request it is authorising.
    void db()
      .update(apiTokens)
      .set({ lastUsedAt: now.toISOString() })
      .where(eq(apiTokens.id, row.token.id))
      .catch(() => undefined);
  }

  return {
    user: toPublicUser(row.user),
    tokenId: row.token.id,
    scopes: row.token.scopes.split(' ').filter(isApiScope),
  };
}
