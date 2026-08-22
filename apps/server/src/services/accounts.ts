import { getAdapter, isGrantRevoked } from '@orbit/adapters';
import { accountGrants, accounts } from '@orbit/db';
import type { AccountTokens, ProviderAdapter, ProviderId, PublicAccount } from '@orbit/shared-types';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../lib/db.js';
import { decryptTokens, encryptTokens } from '../lib/crypto.js';
import { accessTo, levelAllows, type Level, type Need } from './sharing.js';

type AccountRow = typeof accounts.$inferSelect;

/** Refresh this far before actual expiry, so a long request cannot straddle it. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * The scheduled sweep works to a wider margin than a request does. Refreshing
 * an hour early means a sweep can fail several times over before anything the
 * user does is affected.
 */
const PROACTIVE_REFRESH_MS = 60 * 60 * 1000;

/**
 * The API shape. Deliberately cannot carry `encryptedTokens`.
 *
 * `access` describes the caller's relationship to the drive, not the drive
 * itself: the same row is `owner`/`admin` to the person who connected it and
 * `read` to a guest. The client needs it to decide what to even offer -
 * an upload button that always 403s is worse than no upload button.
 */
export function toPublicAccount(row: AccountRow, access?: { isOwner: boolean; level: Level }): PublicAccount {
  return {
    id: row.id,
    provider: row.provider,
    catalogueKey: row.catalogueKey,
    nickname: row.nickname,
    usedBytes: row.usedBytes,
    quotaBytes: row.quotaBytes,
    priorityOrder: row.priorityOrder,
    weight: row.weight,
    status: row.status,
    lastSyncedAt: row.lastSyncedAt,
    lastRefreshedAt: row.lastRefreshedAt,
    connectedAt: row.connectedAt,
    isOwner: access?.isOwner ?? true,
    accessLevel: access?.level ?? 'admin',
  };
}

/**
 * The drives this user may see: their own, plus any they have been granted.
 *
 * Their own come first and in the order they chose. A guest drive is somebody
 * else's and has no place in that ordering, so they follow, oldest grant first.
 */
export async function listAccounts(userId: string): Promise<PublicAccount[]> {
  const own = await db()
    .select()
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .orderBy(accounts.priorityOrder, accounts.connectedAt);

  const guest = await db()
    .select({ account: accounts, level: accountGrants.level })
    .from(accountGrants)
    .innerJoin(accounts, eq(accounts.id, accountGrants.accountId))
    .where(eq(accountGrants.userId, userId))
    .orderBy(accountGrants.createdAt);

  return [
    ...own.map((row) => toPublicAccount(row)),
    ...guest.map((row) => toPublicAccount(row.account, { isOwner: false, level: row.level })),
  ];
}

/**
 * One drive, if this user may do `need` with it.
 *
 * `need` is required rather than defaulted. A default would be `read`, and a
 * mutating caller that forgot to pass anything would then quietly let a guest
 * with read access delete files - a mistake with no symptom until it matters.
 */
export async function getAccountRow(
  userId: string,
  accountId: string,
  need: Need,
): Promise<AccountRow | null> {
  const access = await accessTo(userId, accountId);
  // Not allowed and does not exist are answered identically. Distinguishing
  // them tells a stranger which ids are real.
  if (!access || !levelAllows(access.level, need)) return null;

  const [row] = await db()
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, access.ownerId)))
    .limit(1);
  return row ?? null;
}

/** The owner-only form, for things a guest may never do however high their level. */
export async function getOwnedAccountRow(
  userId: string,
  accountId: string,
): Promise<AccountRow | null> {
  const [row] = await db()
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
    .limit(1);
  return row ?? null;
}

export interface CreateAccountInput {
  userId: string;
  provider: ProviderId;
  catalogueKey: string;
  nickname: string;
  tokens: AccountTokens;
  /**
   * The provider's own id for this account, when it gives us one. Supplying it
   * makes the connection idempotent: authorising the same account again
   * refreshes the existing one instead of adding a duplicate.
   */
  remoteAccountId?: string | undefined;
}

export async function createAccount(input: CreateAccountInput): Promise<PublicAccount> {
  // Connecting the same account twice is the normal case, not an edge case: a
  // grant expires, the owner authorises again, and they expect the connection
  // they already had - with its priority, its weight and its counters - to come
  // back to life rather than to acquire a twin beside a dead entry.
  if (input.remoteAccountId) {
    const [existing] = await db()
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, input.userId),
          eq(accounts.provider, input.provider),
          eq(accounts.remoteAccountId, input.remoteAccountId),
        ),
      )
      .limit(1);

    if (existing) {
      const [updated] = await db()
        .update(accounts)
        .set({
          encryptedTokens: encryptTokens(input.tokens),
          nickname: input.nickname,
          catalogueKey: input.catalogueKey,
          // A fresh grant clears whatever went wrong with the previous one.
          status: 'ok',
          lastRefreshedAt: new Date().toISOString(),
        })
        .where(eq(accounts.id, existing.id))
        .returning();

      if (!updated) throw new Error('Failed to update account');
      return toPublicAccount(updated);
    }
  }

  const [row] = await db()
    .insert(accounts)
    .values({
      id: nanoid(),
      userId: input.userId,
      provider: input.provider,
      catalogueKey: input.catalogueKey,
      nickname: input.nickname,
      remoteAccountId: input.remoteAccountId ?? null,
      encryptedTokens: encryptTokens(input.tokens),
      // New accounts go to the end of the manual priority order.
      priorityOrder: await nextPriority(input.userId),
    })
    .returning();

  if (!row) throw new Error('Failed to create account');
  return toPublicAccount(row);
}

async function nextPriority(userId: string): Promise<number> {
  const rows = await db()
    .select({ priorityOrder: accounts.priorityOrder })
    .from(accounts)
    .where(eq(accounts.userId, userId));
  return rows.reduce((max, row) => Math.max(max, row.priorityOrder), -1) + 1;
}

/**
 * Disconnects a drive. Owner only, however high a guest's level.
 *
 * An admin guest may hand the drive to other people and delete files in it, but
 * the connection itself - somebody else's tokens, somebody else's provider
 * account - is not theirs to sever.
 */
export async function deleteAccount(userId: string, accountId: string): Promise<boolean> {
  const existing = await getOwnedAccountRow(userId, accountId);
  if (!existing) return false;
  await db().delete(accounts).where(eq(accounts.id, accountId));
  return true;
}

/**
 * Hands back an adapter and a set of tokens that are valid *now*, refreshing
 * and persisting them first if they are close to expiry. Every call that talks
 * to a provider should go through this rather than reading the row directly -
 * it is the only place that knows how to keep a connection alive.
 */
export async function useAccount(
  userId: string,
  accountId: string,
  need: Need,
): Promise<{ row: AccountRow; adapter: ProviderAdapter; tokens: AccountTokens } | null> {
  const row = await getAccountRow(userId, accountId, need);
  if (!row) return null;

  const adapter = getAdapter(row.provider);
  let tokens = decryptTokens(row.encryptedTokens);

  const expiring = tokens.expiresAt !== undefined && tokens.expiresAt - Date.now() < REFRESH_MARGIN_MS;

  if (expiring && tokens.refreshToken) {
    try {
      tokens = await adapter.refreshToken(tokens);
      await db()
        .update(accounts)
        .set({ encryptedTokens: encryptTokens(tokens), status: 'ok', lastRefreshedAt: new Date().toISOString() })
        .where(eq(accounts.id, row.id));
    } catch (err) {
      // Only an explicit refusal means the grant is gone. A timeout, a reset
      // connection or a 5xx is the provider having a bad moment, and marking
      // the account dead for that would make the user reconnect an account
      // that never actually stopped working.
      if (!isGrantRevoked(err)) {
        await db().update(accounts).set({ status: 'error' }).where(eq(accounts.id, row.id));
        throw new Error('provider_unavailable');
      }

      await db().update(accounts).set({ status: 'needs_reauth' }).where(eq(accounts.id, row.id));
      throw new Error('needs_reauth');
    }
  }

  return { row, adapter, tokens };
}

/**
 * Refreshes every account whose token is close to expiry. Run on a schedule so
 * a connection stays warm whether or not the user opened the app, and so a
 * genuinely dead grant is discovered and surfaced before they need it rather
 * than at the moment they do.
 */
/**
 * Fills in the label and remote id of connections that were made before Orbit
 * asked for them.
 *
 * Every connection used to be named after the provider unless it was Google
 * Drive, so a Dropbox account said only "Dropbox" - useless the moment there
 * are two - and had no remote id, which is what tells a reconnection from a
 * second account. Rather than making people disconnect and reconnect to fix
 * rows Orbit got wrong, the sweep asks once for the ones still unnamed.
 *
 * Only accounts whose nickname is still the bare provider name are touched: a
 * name somebody chose is theirs, not something to overwrite.
 */
export async function nameUnlabelledAccounts(): Promise<number> {
  const rows = await db().select().from(accounts);
  let named = 0;

  for (const row of rows) {
    if (row.remoteAccountId) continue;

    const adapter = getAdapter(row.provider);
    if (!adapter.getAccountIdentity) continue;
    if (row.nickname !== adapter.displayName) continue;

    try {
      const identity = await adapter.getAccountIdentity(decryptTokens(row.encryptedTokens));
      const label = identity.email ?? identity.displayName;
      if (!label) continue;

      await db()
        .update(accounts)
        .set({ nickname: label, remoteAccountId: identity.email ?? null })
        .where(eq(accounts.id, row.id));
      named += 1;
    } catch {
      // A provider having a bad moment is not a reason to fail the sweep; the
      // next one will try again.
    }
  }

  return named;
}

export async function refreshExpiringAccounts(now = new Date()): Promise<{
  refreshed: number;
  revoked: number;
  failed: number;
}> {
  const rows = await db().select().from(accounts);
  const result = { refreshed: 0, revoked: 0, failed: 0 };

  for (const row of rows) {
    if (row.status === 'needs_reauth') continue;

    const tokens = decryptTokens(row.encryptedTokens);
    if (!tokens.refreshToken || tokens.expiresAt === undefined) continue;
    // Refreshed well ahead of expiry, so one failed sweep is not fatal.
    if (tokens.expiresAt - now.getTime() > PROACTIVE_REFRESH_MS) continue;

    try {
      const refreshed = await getAdapter(row.provider).refreshToken(tokens);
      await db()
        .update(accounts)
        .set({
          encryptedTokens: encryptTokens(refreshed),
          status: 'ok',
          lastRefreshedAt: now.toISOString(),
        })
        .where(eq(accounts.id, row.id));
      result.refreshed += 1;
    } catch (err) {
      if (isGrantRevoked(err)) {
        await db().update(accounts).set({ status: 'needs_reauth' }).where(eq(accounts.id, row.id));
        result.revoked += 1;
      } else {
        result.failed += 1;
      }
    }
  }

  return result;
}

/** Refreshes the cached quota figures. Cheap enough to call on the accounts view. */
export async function refreshQuota(userId: string, accountId: string): Promise<PublicAccount | null> {
  const active = await useAccount(userId, accountId, 'read');
  if (!active) return null;

  const quota = await active.adapter.getQuota(active.tokens);

  const [row] = await db()
    .update(accounts)
    .set({ usedBytes: quota.usedBytes, quotaBytes: quota.totalBytes })
    .where(eq(accounts.id, accountId))
    .returning();

  return row ? toPublicAccount(row) : null;
}
