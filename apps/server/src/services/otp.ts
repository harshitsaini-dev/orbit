import { randomInt } from 'node:crypto';
import { otpCodes } from '@orbit/db';
import { and, desc, eq, gt, isNull, lt } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../lib/db.js';
import { hashSecret, verifySecret } from '../lib/hash.js';

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

export type IssueResult =
  | { ok: true; code: string; expiresAt: Date }
  | { ok: false; reason: 'cooldown'; retryAfterMs: number };

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'no_code' | 'expired' | 'too_many_attempts' | 'mismatch' };

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function generateCode(): string {
  // randomInt is uniform; padStart keeps leading zeros so every code is 6 digits.
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
}

/**
 * Issues a fresh code, refusing if one was sent within the cooldown window.
 * The plaintext code is returned exactly once, for the mailer - it is stored
 * only as a scrypt hash and never logged.
 */
export async function issueOtp(email: string, now = new Date()): Promise<IssueResult> {
  const address = normaliseEmail(email);

  const [latest] = await db()
    .select({ createdAt: otpCodes.createdAt })
    .from(otpCodes)
    .where(eq(otpCodes.email, address))
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);

  if (latest) {
    const elapsed = now.getTime() - new Date(latest.createdAt).getTime();
    if (elapsed < OTP_RESEND_COOLDOWN_MS) {
      return { ok: false, reason: 'cooldown', retryAfterMs: OTP_RESEND_COOLDOWN_MS - elapsed };
    }
  }

  const code = generateCode();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS);

  await db().insert(otpCodes).values({
    id: nanoid(),
    email: address,
    codeHash: await hashSecret(code),
    expiresAt: expiresAt.toISOString(),
    createdAt: now.toISOString(),
  });

  return { ok: true, code, expiresAt };
}

/**
 * Verifies and consumes a code. A wrong guess burns an attempt; a correct one
 * marks the row consumed so the same code can never be replayed.
 */
export async function verifyOtp(email: string, code: string, now = new Date()): Promise<VerifyResult> {
  const address = normaliseEmail(email);

  const [row] = await db()
    .select()
    .from(otpCodes)
    .where(and(eq(otpCodes.email, address), isNull(otpCodes.consumedAt), gt(otpCodes.expiresAt, now.toISOString())))
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);

  if (!row) return { ok: false, reason: 'no_code' };
  if (row.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };

  const matches = await verifySecret(code, row.codeHash);

  if (!matches) {
    await db()
      .update(otpCodes)
      .set({ attempts: row.attempts + 1 })
      .where(eq(otpCodes.id, row.id));
    return { ok: false, reason: 'mismatch' };
  }

  await db()
    .update(otpCodes)
    .set({ consumedAt: now.toISOString() })
    .where(eq(otpCodes.id, row.id));

  return { ok: true };
}

/** Housekeeping for the cron pass - expired and consumed codes have no value. */
export async function purgeStaleOtps(now = new Date()): Promise<void> {
  await db().delete(otpCodes).where(lt(otpCodes.expiresAt, now.toISOString()));
}
