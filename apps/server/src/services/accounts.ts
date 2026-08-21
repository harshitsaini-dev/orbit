import { getAdapter } from '@orbit/adapters';
import { accounts } from '@orbit/db';
import type { AccountTokens, ProviderAdapter, ProviderId, PublicAccount } from '@orbit/shared-types';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../lib/db.js';
import { decryptTokens, encryptTokens } from '../lib/crypto.js';

type AccountRow = typeof accounts.$inferSelect;

/** Refresh this far before actual expiry, so a long request cannot straddle it. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** The API shape. Deliberately cannot carry `encryptedTokens`. */
export function toPublicAccount(row: AccountRow): PublicAccount {
  return {
    id: row.id,
    provider: row.provider,
    nickname: row.nickname,
    usedBytes: row.usedBytes,
    quotaBytes: row.quotaBytes,
    priorityOrder: row.priorityOrder,
    weight: row.weight,
    status: row.status,
    lastSyncedAt: row.lastSyncedAt,
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
}

export async function createAccount(input: CreateAccountInput): Promise<PublicAccount> {
  const [row] = await db()
    .insert(accounts)
    .values({
      id: nanoid(),
      userId: input.userId,
      provider: input.provider,
      catalogueKey: input.catalogueKey,
      nickname: input.nickname,
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
        .set({ encryptedTokens: encryptTokens(tokens), status: 'ok' })
        .where(eq(accounts.id, row.id));
    } catch {
      // A refresh that fails means the grant was revoked or expired. Mark it so
      // the UI can prompt a reconnect instead of failing every later request.
      await db().update(accounts).set({ status: 'needs_reauth' }).where(eq(accounts.id, row.id));
      throw new Error('needs_reauth');
    }
  }

  return { row, adapter, tokens };
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
