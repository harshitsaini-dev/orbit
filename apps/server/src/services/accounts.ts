import { getAdapter, isGrantRevoked } from '@orbit/adapters';
import { accounts } from '@orbit/db';
import type { AccountTokens, ProviderAdapter, ProviderId, PublicAccount } from '@orbit/shared-types';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../lib/db.js';
import { decryptTokens, encryptTokens } from '../lib/crypto.js';

type AccountRow = typeof accounts.$inferSelect;

/** Refresh this far before actual expiry, so a long request cannot straddle it. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * The scheduled sweep works to a wider margin than a request does. Refreshing
 * an hour early means a sweep can fail several times over before anything the
 * user does is affected.
 */
const PROACTIVE_REFRESH_MS = 60 * 60 * 1000;

/** The API shape. Deliberately cannot carry `encryptedTokens`. */
export function toPublicAccount(row: AccountRow): PublicAccount {
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
  };
}

export async function listAccounts(userId: string): Promise<PublicAccount[]> {
  const rows = await db()
    .select()
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .orderBy(accounts.priorityOrder, accounts.connectedAt);
  return rows.map(toPublicAccount);
}

export async function getAccountRow(userId: string, accountId: string): Promise<AccountRow | null> {
  const [row] = await db()
    .select()
    .from(accounts)
    // Scoped by user as well as id: an account id must never be enough on its own.
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

export async function deleteAccount(userId: string, accountId: string): Promise<boolean> {
  const existing = await getAccountRow(userId, accountId);
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
): Promise<{ row: AccountRow; adapter: ProviderAdapter; tokens: AccountTokens } | null> {
  const row = await getAccountRow(userId, accountId);
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
  const active = await useAccount(userId, accountId);
  if (!active) return null;

  const quota = await active.adapter.getQuota(active.tokens);

  const [row] = await db()
    .update(accounts)
    .set({ usedBytes: quota.usedBytes, quotaBytes: quota.totalBytes })
    .where(eq(accounts.id, accountId))
    .returning();

  return row ? toPublicAccount(row) : null;
}
