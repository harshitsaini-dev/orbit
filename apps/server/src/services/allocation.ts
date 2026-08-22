import { accounts, users } from '@orbit/db';
import type { AllocationStrategy } from '@orbit/shared-types';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../lib/db.js';

/**
 * Which account an upload goes to when the user has not picked one.
 *
 * The point of connecting several drives is that they behave as one, and that
 * only works if Orbit can decide where a file lands. Every strategy here
 * answers the same question differently, and each is a reasonable default for
 * someone: rotate evenly, favour the emptiest, or follow a list.
 *
 * An account that cannot take the file is never chosen. Returning one that will
 * refuse the upload turns a solvable problem into a failure halfway through a
 * transfer.
 */

type AccountRow = typeof accounts.$inferSelect;

export interface AllocationResult {
  account: AccountRow;
  /** Why this one, in words the settings page can show. */
  reason: string;
}

/** Treated as "not usable" whatever the strategy says. */
function usable(account: AccountRow, sizeBytes: number): boolean {
  if (account.status !== 'ok') return false;

  // A store that reports no allowance cannot be shown to be full, so it is
  // never excluded for being so - a bucket has no limit to compare against.
  if (account.quotaBytes <= 0) return true;

  return account.quotaBytes - account.usedBytes >= sizeBytes;
}

export async function chooseAccount(
  userId: string,
  sizeBytes: number,
): Promise<AllocationResult | null> {
  const [user] = await db().select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return null;

  const all = await db()
    .select()
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .orderBy(asc(accounts.priorityOrder));

  const candidates = all.filter((account) => usable(account, sizeBytes));

  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length === 1) {
    return { account: candidates[0]!, reason: 'the only account with room' };
  }

  switch (user.allocationStrategy) {
    case 'most_free':
      return byMostFree(candidates);
    case 'least_used':
      return byLeastUsed(candidates);
    case 'manual':
      // Ordered by priority already, so the first usable one is the answer.
      return { account: candidates[0]!, reason: 'first in your manual order with room' };
    case 'weighted_round_robin':
      return await byWeight(userId, candidates, user.allocationCursor);
    case 'round_robin':
    default:
      return await byRotation(userId, candidates, user.allocationCursor);
  }
}

function byMostFree(candidates: AccountRow[]): AllocationResult {
  // An account with no stated allowance sorts last rather than first: "unknown"
  // is not "infinite", and treating it as the emptiest would send everything
  // to a bucket.
  const free = (account: AccountRow) =>
    account.quotaBytes > 0 ? account.quotaBytes - account.usedBytes : -1;

  const best = candidates.reduce((a, b) => (free(b) > free(a) ? b : a));
  return { account: best, reason: 'the most free space' };
}

function byLeastUsed(candidates: AccountRow[]): AllocationResult {
  // Bytes uploaded *through Orbit*, not bytes in the account: the point is to
  // spread what Orbit puts there, not to fill up whatever was emptiest to
  // begin with.
  const best = candidates.reduce((a, b) =>
    b.uploadedViaOrbitBytes < a.uploadedViaOrbitBytes ? b : a,
  );
  return { account: best, reason: 'the least uploaded to through Orbit' };
}

/**
 * Round robin, with the cursor stored per user.
 *
 * The cursor counts *uploads*, not positions, so it stays meaningful when an
 * account is added or disconnected between two uploads - a positional cursor
 * would silently start skipping one.
 */
async function byRotation(
  userId: string,
  candidates: AccountRow[],
  cursor: number,
): Promise<AllocationResult> {
  const account = candidates[cursor % candidates.length]!;
  await advance(userId, cursor);
  return { account, reason: 'next in the rotation' };
}

/**
 * Weighted round robin, expanded rather than randomised.
 *
 * A weighted random pick gives the right ratio only on average, and a handful
 * of uploads is not an average - three files could all land in the same place.
 * Expanding the weights into a list and rotating through it gives the stated
 * ratio over every window, which is what someone setting 3:1:1 expects.
 */
async function byWeight(
  userId: string,
  candidates: AccountRow[],
  cursor: number,
): Promise<AllocationResult> {
  const slots: AccountRow[] = [];
  for (const account of candidates) {
    // A weight of zero means "never", which is a legitimate way to park an
    // account without disconnecting it.
    const weight = Math.max(0, Math.min(account.weight, 100));
    for (let index = 0; index < weight; index += 1) slots.push(account);
  }

  if (slots.length === 0) return byRotation(userId, candidates, cursor);

  const account = slots[cursor % slots.length]!;
  await advance(userId, cursor);
  return { account, reason: `weighted rotation (weight ${account.weight})` };
}

async function advance(userId: string, cursor: number): Promise<void> {
  // Wrapped well below any integer limit; the modulo above does the real work,
  // so the absolute value never matters.
  await db()
    .update(users)
    .set({ allocationCursor: (cursor + 1) % 1_000_000 })
    .where(eq(users.id, userId));
}

/**
 * Records what an upload actually cost, once it has landed.
 *
 * `least_used` reads this, and the storage figures on the dashboard drift from
 * reality between quota refreshes without it.
 */
export async function recordUpload(
  userId: string,
  accountId: string,
  sizeBytes: number,
): Promise<void> {
  const [account] = await db()
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
    .limit(1);

  if (!account) return;

  await db()
    .update(accounts)
    .set({
      uploadedViaOrbitBytes: account.uploadedViaOrbitBytes + sizeBytes,
      usedBytes: account.usedBytes + sizeBytes,
    })
    .where(eq(accounts.id, accountId));
}

export async function setStrategy(userId: string, strategy: AllocationStrategy): Promise<void> {
  await db().update(users).set({ allocationStrategy: strategy }).where(eq(users.id, userId));
}

export async function setAccountWeight(
  userId: string,
  accountId: string,
  weight: number,
): Promise<boolean> {
  const [updated] = await db()
    .update(accounts)
    .set({ weight: Math.max(0, Math.min(Math.round(weight), 100)) })
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
    .returning();

  return Boolean(updated);
}

export async function setAccountPriority(
  userId: string,
  order: string[],
): Promise<void> {
  // Written in the order given, so the list the user dragged is the list that
  // is stored.
  for (const [index, accountId] of order.entries()) {
    await db()
      .update(accounts)
      .set({ priorityOrder: index })
      .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)));
  }
}
