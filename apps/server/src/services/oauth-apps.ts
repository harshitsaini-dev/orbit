import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { oauthApps, oauthCodes, oauthGrants, users } from '@orbit/db';
import { isApiScope, type ApiScope, type PublicUser } from '@orbit/shared-types';
import { and, desc, eq, lt } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../lib/db.js';
import { toPublicUser } from './session.js';

/**
 * Orbit as an authorisation server.
 *
 * A personal access token is a credential its owner pastes into their own
 * script. This is the other thing: a program somebody *else* wrote, asking a
 * person for access to their drives, without that person ever handing over a
 * password. There is no way to approximate it with a token field, which is why
 * it exists.
 *
 * Deliberately a small subset of OAuth 2.1, and the omissions are the point.
 * Only the authorisation code flow, PKCE always rather than optionally, exact
 * redirect matching rather than prefix, codes usable once and for a minute.
 * The implicit flow and the password grant are not here at all; both hand a
 * credential to somewhere it cannot be kept, and both were removed from the
 * specification for that reason.
 */

export interface PublicOAuthApp {
  id: string;
  name: string;
  description: string | null;
  website: string | null;
  clientId: string;
  /** Whether it holds a secret. A public client authenticates with PKCE only. */
  confidential: boolean;
  redirectUris: string[];
  scopes: ApiScope[];
  createdAt: string;
}

/** Long enough that a minute of retries gets nowhere near guessing one. */
const CODE_TTL_MS = 60_000;

/**
 * An hour for an access token, and a refresh token that does not expire on its
 * own.
 *
 * The short life is what makes a leaked access token survivable; the refresh
 * token is the thing to guard, and it is revoked by the person rather than by
 * a clock - an app that stops working after thirty days without anybody asking
 * it to is an app people learn to re-authorise on a schedule and stop reading
 * the consent screen for.
 */
const ACCESS_TTL_MS = 3_600_000;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function toPublicApp(row: typeof oauthApps.$inferSelect): PublicOAuthApp {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    website: row.website,
    clientId: row.clientId,
    confidential: row.clientSecretHash !== null,
    redirectUris: JSON.parse(row.redirectUris) as string[],
    scopes: row.scopes.split(' ').filter(isApiScope),
    createdAt: row.createdAt,
  };
}

/**
 * Whether a redirect address is one an authorisation may be sent to.
 *
 * https everywhere, with two exceptions that are not loopholes: `http://127.0.0.1`
 * and `http://localhost`, which is how a desktop or CLI app receives a code -
 * it opens a browser at a loopback port it is itself listening on, and there is
 * no network for anyone to be on the path of. A custom scheme (`myapp://`) is
 * allowed for the same reason on a phone.
 */
export function isUsableRedirect(raw: string): boolean {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  // A fragment is dropped by the browser before the request is even made, so a
  // redirect carrying one cannot mean what its author thinks it means.
  if (url.hash) return false;

  if (url.protocol === 'https:') return true;

  if (url.protocol === 'http:') {
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  }

  // A private scheme: not http at all, so nothing is travelling over a network.
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && url.protocol !== 'javascript:';
}

export async function listApps(ownerId: string): Promise<PublicOAuthApp[]> {
  const rows = await db()
    .select()
    .from(oauthApps)
    .where(eq(oauthApps.ownerId, ownerId))
    .orderBy(desc(oauthApps.createdAt));

  return rows.map(toPublicApp);
}

export async function findByClientId(clientId: string): Promise<PublicOAuthApp | null> {
  const [row] = await db()
    .select()
    .from(oauthApps)
    .where(eq(oauthApps.clientId, clientId))
    .limit(1);

  return row ? toPublicApp(row) : null;
}

export async function createApp(input: {
  ownerId: string;
  name: string;
  description?: string | undefined;
  website?: string | undefined;
  redirectUris: string[];
  scopes: ApiScope[];
  confidential: boolean;
}): Promise<{ app: PublicOAuthApp; secret: string | null }> {
  const clientId = `orbit_app_${randomBytes(12).toString('base64url')}`;
  const secret = input.confidential ? `orbit_secret_${randomBytes(24).toString('base64url')}` : null;

  const [row] = await db()
    .insert(oauthApps)
    .values({
      id: nanoid(),
      ownerId: input.ownerId,
      name: input.name,
      description: input.description ?? null,
      website: input.website ?? null,
      clientId,
      clientSecretHash: secret ? hash(secret) : null,
      redirectUris: JSON.stringify(input.redirectUris),
      scopes: input.scopes.join(' '),
      createdAt: new Date().toISOString(),
    })
    .returning();

  if (!row) throw new Error('Failed to create app');
  return { app: toPublicApp(row), secret };
}

export async function rotateAppSecret(ownerId: string, id: string): Promise<string | null> {
  const secret = `orbit_secret_${randomBytes(24).toString('base64url')}`;

  const [row] = await db()
    .update(oauthApps)
    .set({ clientSecretHash: hash(secret) })
    .where(and(eq(oauthApps.id, id), eq(oauthApps.ownerId, ownerId)))
    .returning();

  return row ? secret : null;
}

export async function deleteApp(ownerId: string, id: string): Promise<boolean> {
  const rows = await db()
    .delete(oauthApps)
    .where(and(eq(oauthApps.id, id), eq(oauthApps.ownerId, ownerId)))
    .returning();

  return rows.length > 0;
}

/**
 * The consent step, once a person has said yes.
 *
 * Returns the code to put on the redirect. Everything about the request was
 * validated before the screen was drawn - this only records what was agreed.
 */
export async function issueCode(input: {
  appId: string;
  userId: string;
  redirectUri: string;
  scopes: ApiScope[];
  challenge: string;
}): Promise<string> {
  const code = randomBytes(32).toString('base64url');

  await db().insert(oauthCodes).values({
    codeHash: hash(code),
    appId: input.appId,
    userId: input.userId,
    redirectUri: input.redirectUri,
    scopes: input.scopes.join(' '),
    challenge: input.challenge,
    expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    createdAt: new Date().toISOString(),
  });

  return code;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: ApiScope[];
}

type ExchangeFailure =
  | 'invalid_client'
  | 'invalid_grant'
  | 'invalid_redirect'
  | 'invalid_verifier';

/**
 * Turns a code into tokens.
 *
 * Every check here is one that has been the subject of a real attack: the code
 * has to exist, be unused, be unexpired, have been issued to this client, come
 * back to the same redirect it was sent to, and be accompanied by the verifier
 * whose hash was registered when the flow began.
 *
 * A reused code revokes the grant it created. That is the specification's
 * advice and the reason the row is marked rather than deleted: a second
 * redemption means somebody else has the code, and the only safe reading is
 * that whatever the first redemption produced is compromised too.
 */
export async function exchangeCode(input: {
  code: string;
  clientId: string;
  clientSecret?: string | undefined;
  redirectUri: string;
  verifier: string;
}): Promise<{ ok: true; tokens: IssuedTokens } | { ok: false; why: ExchangeFailure }> {
  const [app] = await db()
    .select()
    .from(oauthApps)
    .where(eq(oauthApps.clientId, input.clientId))
    .limit(1);

  if (!app) return { ok: false, why: 'invalid_client' };

  if (app.clientSecretHash) {
    if (!input.clientSecret || !same(hash(input.clientSecret), app.clientSecretHash)) {
      return { ok: false, why: 'invalid_client' };
    }
  }

  const [row] = await db()
    .select()
    .from(oauthCodes)
    .where(eq(oauthCodes.codeHash, hash(input.code)))
    .limit(1);

  if (!row || row.appId !== app.id) return { ok: false, why: 'invalid_grant' };

  if (row.usedAt) {
    // Seen twice: somebody else has this code. Whatever the first redemption
    // produced cannot be trusted either.
    await revokeGrant(row.userId, row.appId);
    return { ok: false, why: 'invalid_grant' };
  }

  if (row.expiresAt <= new Date().toISOString()) return { ok: false, why: 'invalid_grant' };
  if (row.redirectUri !== input.redirectUri) return { ok: false, why: 'invalid_redirect' };

  // S256 only. The `plain` method sends the verifier itself on the first leg,
  // which is the leg being protected.
  const computed = createHash('sha256').update(input.verifier).digest('base64url');
  if (!same(computed, row.challenge)) return { ok: false, why: 'invalid_verifier' };

  await db()
    .update(oauthCodes)
    .set({ usedAt: new Date().toISOString() })
    .where(eq(oauthCodes.codeHash, row.codeHash));

  const scopes = row.scopes.split(' ').filter(isApiScope);
  const tokens = await mintTokens(row.appId, row.userId, scopes);

  return { ok: true, tokens };
}

async function mintTokens(
  appId: string,
  userId: string,
  scopes: ApiScope[],
): Promise<IssuedTokens> {
  const accessToken = `orbit_at_${randomBytes(24).toString('base64url')}`;
  const refreshToken = `orbit_rt_${randomBytes(24).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + ACCESS_TTL_MS).toISOString();

  await db()
    .insert(oauthGrants)
    .values({
      id: nanoid(),
      appId,
      userId,
      scopes: scopes.join(' '),
      refreshHash: hash(refreshToken),
      accessHash: hash(accessToken),
      accessExpiresAt: expiresAt,
      revokedAt: null,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: [oauthGrants.appId, oauthGrants.userId],
      // Authorising the same app again replaces the grant. Two live grants for
      // one app would make "which apps can reach my drives" a longer answer
      // than the truth.
      set: {
        scopes: scopes.join(' '),
        refreshHash: hash(refreshToken),
        accessHash: hash(accessToken),
        accessExpiresAt: expiresAt,
        revokedAt: null,
      },
    });

  return { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TTL_MS / 1000), scopes };
}

export async function refresh(input: {
  refreshToken: string;
  clientId: string;
  clientSecret?: string | undefined;
}): Promise<{ ok: true; tokens: IssuedTokens } | { ok: false; why: ExchangeFailure }> {
  const [app] = await db()
    .select()
    .from(oauthApps)
    .where(eq(oauthApps.clientId, input.clientId))
    .limit(1);

  if (!app) return { ok: false, why: 'invalid_client' };

  if (app.clientSecretHash) {
    if (!input.clientSecret || !same(hash(input.clientSecret), app.clientSecretHash)) {
      return { ok: false, why: 'invalid_client' };
    }
  }

  const [grant] = await db()
    .select()
    .from(oauthGrants)
    .where(eq(oauthGrants.refreshHash, hash(input.refreshToken)))
    .limit(1);

  if (!grant || grant.revokedAt || grant.appId !== app.id) {
    return { ok: false, why: 'invalid_grant' };
  }

  // Rotated on every use: a refresh token that never changes is one a copy of
  // stays valid for ever.
  const tokens = await mintTokens(grant.appId, grant.userId, grant.scopes.split(' ').filter(isApiScope));

  return { ok: true, tokens };
}

export interface OAuthCaller {
  user: PublicUser;
  grantId: string;
  appName: string;
  scopes: ApiScope[];
}

/** Resolves an access token, for the middleware that guards /v1. */
export async function resolveAccessToken(raw: string): Promise<OAuthCaller | null> {
  if (!raw.startsWith('orbit_at_')) return null;

  const [row] = await db()
    .select({ grant: oauthGrants, user: users, app: oauthApps })
    .from(oauthGrants)
    .innerJoin(users, eq(users.id, oauthGrants.userId))
    .innerJoin(oauthApps, eq(oauthApps.id, oauthGrants.appId))
    .where(eq(oauthGrants.accessHash, hash(raw)))
    .limit(1);

  if (!row) return null;
  if (row.grant.revokedAt) return null;
  if (!row.grant.accessExpiresAt || row.grant.accessExpiresAt <= new Date().toISOString()) {
    return null;
  }

  void db()
    .update(oauthGrants)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(oauthGrants.id, row.grant.id))
    .catch(() => undefined);

  return {
    user: toPublicUser(row.user),
    grantId: row.grant.id,
    appName: row.app.name,
    scopes: row.grant.scopes.split(' ').filter(isApiScope),
  };
}

export interface AllowedApp {
  grantId: string;
  appId: string;
  name: string;
  website: string | null;
  scopes: ApiScope[];
  lastUsedAt: string | null;
  createdAt: string;
}

/** What this person has allowed, for the page where they take it back. */
export async function allowedApps(userId: string): Promise<AllowedApp[]> {
  const rows = await db()
    .select({ grant: oauthGrants, app: oauthApps })
    .from(oauthGrants)
    .innerJoin(oauthApps, eq(oauthApps.id, oauthGrants.appId))
    .where(eq(oauthGrants.userId, userId))
    .orderBy(desc(oauthGrants.createdAt));

  return rows
    .filter((row) => !row.grant.revokedAt)
    .map((row) => ({
      grantId: row.grant.id,
      appId: row.app.id,
      name: row.app.name,
      website: row.app.website,
      scopes: row.grant.scopes.split(' ').filter(isApiScope),
      lastUsedAt: row.grant.lastUsedAt,
      createdAt: row.grant.createdAt,
    }));
}

/**
 * Takes access back.
 *
 * The tokens are cleared rather than only marked revoked, so a stolen one
 * cannot be matched against anything even if the flag were ever missed.
 */
export async function revokeGrant(userId: string, appId: string): Promise<boolean> {
  const rows = await db()
    .update(oauthGrants)
    .set({
      revokedAt: new Date().toISOString(),
      refreshHash: null,
      accessHash: null,
      accessExpiresAt: null,
    })
    .where(and(eq(oauthGrants.userId, userId), eq(oauthGrants.appId, appId)))
    .returning();

  return rows.length > 0;
}

/** Codes that were never redeemed. Nothing reads them; they only accumulate. */
export async function pruneCodes(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 86_400_000).toISOString();
  const rows = await db().delete(oauthCodes).where(lt(oauthCodes.expiresAt, cutoff)).returning();

  return rows.length;
}
