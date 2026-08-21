import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  issueOtp,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
  verifyOtp,
} from './otp.js';
import { useTestDatabase } from '../test-utils.js';

const EMAIL = 'pilot@example.com';

beforeEach(async () => {
  await useTestDatabase();
});

describe('issueOtp', () => {
  it('returns a six-digit code', async () => {
    const result = await issueOtp(EMAIL);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.code, /^\d{6}$/);
  });

  it('refuses a resend inside the cooldown window', async () => {
    const start = new Date('2026-08-21T10:00:00Z');
    await issueOtp(EMAIL, start);

    const tooSoon = await issueOtp(EMAIL, new Date(start.getTime() + 5_000));
    assert.equal(tooSoon.ok, false);
    if (tooSoon.ok) return;
    assert.equal(tooSoon.reason, 'cooldown');
  });

  it('allows a resend once the cooldown has passed', async () => {
    const start = new Date('2026-08-21T10:00:00Z');
    await issueOtp(EMAIL, start);

    const later = await issueOtp(EMAIL, new Date(start.getTime() + OTP_RESEND_COOLDOWN_MS + 1));
    assert.equal(later.ok, true);
  });

  it('never stores the code in plaintext', async () => {
    const issued = await issueOtp(EMAIL);
    assert.equal(issued.ok, true);
    if (!issued.ok) return;

    const { db } = await import('../lib/db.js');
    const { otpCodes } = await import('@orbit/db');
    const rows = await db().select().from(otpCodes);

    assert.equal(rows.length, 1);
    assert.ok(!rows[0]!.codeHash.includes(issued.code));
    assert.match(rows[0]!.codeHash, /^scrypt\$/);
  });
});

describe('verifyOtp', () => {
  it('accepts the correct code', async () => {
    const issued = await issueOtp(EMAIL);
    if (!issued.ok) throw new Error('expected a code');

    const result = await verifyOtp(EMAIL, issued.code);
    assert.equal(result.ok, true);
  });

  it('is case-insensitive about the address', async () => {
    const issued = await issueOtp('Pilot@Example.com');
    if (!issued.ok) throw new Error('expected a code');

    const result = await verifyOtp('PILOT@EXAMPLE.COM', issued.code);
    assert.equal(result.ok, true);
  });

  it('rejects a wrong code', async () => {
    const issued = await issueOtp(EMAIL);
    if (!issued.ok) throw new Error('expected a code');

    const wrong = issued.code === '000000' ? '111111' : '000000';
    const result = await verifyOtp(EMAIL, wrong);
    assert.equal(result.ok, false);
  });

  it('cannot be replayed once consumed', async () => {
    const issued = await issueOtp(EMAIL);
    if (!issued.ok) throw new Error('expected a code');

    assert.equal((await verifyOtp(EMAIL, issued.code)).ok, true);

    const replay = await verifyOtp(EMAIL, issued.code);
    assert.equal(replay.ok, false);
    if (replay.ok) return;
    assert.equal(replay.reason, 'no_code');
  });

  it('locks out after the attempt limit, even if the right code arrives later', async () => {
    const issued = await issueOtp(EMAIL);
    if (!issued.ok) throw new Error('expected a code');
    const wrong = issued.code === '000000' ? '111111' : '000000';

    for (let i = 0; i < OTP_MAX_ATTEMPTS; i += 1) {
      await verifyOtp(EMAIL, wrong);
    }

    const result = await verifyOtp(EMAIL, issued.code);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'too_many_attempts');
  });

  it('rejects an expired code', async () => {
    const start = new Date('2026-08-21T10:00:00Z');
    const issued = await issueOtp(EMAIL, start);
    if (!issued.ok) throw new Error('expected a code');

    const result = await verifyOtp(EMAIL, issued.code, new Date(start.getTime() + OTP_TTL_MS + 1));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'no_code');
  });

  it('rejects when no code was ever issued', async () => {
    const result = await verifyOtp('stranger@example.com', '123456');
    assert.equal(result.ok, false);
  });
});
