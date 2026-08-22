import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

const { chooseAccount, recordUpload, setAccountWeight, setStrategy, wantsToChoose } = await import(
  './allocation.js'
);
const { createAccount } = await import('./accounts.js');
const { getLocalUser } = await import('./users.js');
const { useTestDatabase } = await import('../test-utils.js');
const { db } = await import('../lib/db.js');
const { accounts } = await import('@orbit/db');
const { eq } = await import('drizzle-orm');

beforeEach(useTestDatabase);

async function seed(
  nickname: string,
  fields: {
    quotaBytes?: number;
    usedBytes?: number;
    uploaded?: number;
    weight?: number;
    status?: 'ok' | 'needs_reauth';
  } = {},
) {
  const user = await getLocalUser();
  const account = await createAccount({
    userId: user.id,
    provider: 'google_drive',
    catalogueKey: 'google_drive',
    nickname,
    tokens: {
      accessToken: 'access-sentinel',
      refreshToken: 'refresh-sentinel',
      expiresAt: Date.now() + 3_600_000,
    },
  });

  await db()
    .update(accounts)
    .set({
      quotaBytes: fields.quotaBytes ?? 1_000_000,
      usedBytes: fields.usedBytes ?? 0,
      uploadedViaOrbitBytes: fields.uploaded ?? 0,
      weight: fields.weight ?? 1,
      status: fields.status ?? 'ok',
    })
    .where(eq(accounts.id, account.id));

  return { userId: user.id, accountId: account.id };
}

async function pickMany(userId: string, times: number): Promise<string[]> {
  const picks: string[] = [];
  for (let index = 0; index < times; index += 1) {
    picks.push((await chooseAccount(userId, 10))!.account.nickname);
  }
  return picks;
}

describe('choosing where an upload goes', () => {
  it('never picks an account without room for the file', async () => {
    // Returning one that will refuse turns a solvable problem into a failure
    // halfway through a transfer.
    const { userId } = await seed('full', { quotaBytes: 100, usedBytes: 100 });
    await seed('roomy', { quotaBytes: 1_000_000 });

    assert.equal((await chooseAccount(userId, 5000))?.account.nickname, 'roomy');
  });

  it('never picks an account that needs reconnecting', async () => {
    const { userId } = await seed('broken', { status: 'needs_reauth' });
    await seed('working');

    assert.equal((await chooseAccount(userId, 10))?.account.nickname, 'working');
  });

  it('returns nothing when no account can take the file', async () => {
    const { userId } = await seed('small', { quotaBytes: 100, usedBytes: 100 });
    assert.equal(await chooseAccount(userId, 5000), null);
  });

  it('does not exclude a store that reports no allowance', async () => {
    // A bucket has no limit to compare against, so it can never be shown to be
    // full - excluding it would make buckets unusable as upload targets.
    const { userId } = await seed('bucket', { quotaBytes: 0 });
    assert.equal((await chooseAccount(userId, 10_000_000))?.account.nickname, 'bucket');
  });
});

describe('round robin', () => {
  it('alternates between accounts rather than filling one', async () => {
    const { userId } = await seed('first');
    await seed('second');

    assert.deepEqual(await pickMany(userId, 4), ['first', 'second', 'first', 'second']);
  });

  it('keeps using every account when one is added between uploads', async () => {
    // A cursor counting positions rather than uploads would start skipping one
    // the moment the list changed length.
    const { userId } = await seed('a');
    await seed('b');

    await chooseAccount(userId, 10);
    await seed('c');

    const picks = await pickMany(userId, 3);
    assert.equal(new Set(picks).size, 3, `expected all three to be used, got ${picks.join(', ')}`);
  });
});

describe('weighted round robin', () => {
  it('honours the ratio over a window rather than on average', async () => {
    // A weighted random pick gives 3:1 only across many uploads; three files
    // could all land in the same place. Expanding the weights gives the stated
    // ratio every time round.
    const { userId } = await seed('heavy', { weight: 3 });
    await seed('light', { weight: 1 });
    await setStrategy(userId, 'weighted_round_robin');

    const picks = await pickMany(userId, 8);
    assert.equal(picks.filter((name) => name === 'heavy').length, 6);
    assert.equal(picks.filter((name) => name === 'light').length, 2);
  });

  it('treats a weight of zero as "never", without disconnecting anything', async () => {
    const { userId, accountId } = await seed('parked');
    await seed('active');
    await setStrategy(userId, 'weighted_round_robin');
    await setAccountWeight(userId, accountId, 0);

    const picks = await pickMany(userId, 4);
    assert.ok(!picks.includes('parked'), picks.join(', '));
  });
});

describe('most free', () => {
  it('picks the account with the most room left', async () => {
    const { userId } = await seed('nearly-full', { quotaBytes: 1000, usedBytes: 900 });
    await seed('empty', { quotaBytes: 1000, usedBytes: 10 });
    await setStrategy(userId, 'most_free');

    assert.equal((await chooseAccount(userId, 10))?.account.nickname, 'empty');
  });

  it('does not treat an unknown allowance as an infinite one', async () => {
    // "Unknown" is not "empty"; sorting a bucket first would send everything
    // there and leave the drives untouched.
    const { userId } = await seed('bucket', { quotaBytes: 0 });
    await seed('drive', { quotaBytes: 1_000_000, usedBytes: 0 });
    await setStrategy(userId, 'most_free');

    assert.equal((await chooseAccount(userId, 10))?.account.nickname, 'drive');
  });
});

describe('least used', () => {
  it('counts what Orbit put there, not what was already there', async () => {
    // The point is to spread what Orbit uploads, not to fill whichever account
    // happened to be emptiest to begin with.
    const { userId } = await seed('busy', { usedBytes: 10, uploaded: 900 });
    await seed('quiet', { usedBytes: 900_000, uploaded: 5 });
    await setStrategy(userId, 'least_used');

    assert.equal((await chooseAccount(userId, 10))?.account.nickname, 'quiet');
  });

  it('follows the uploads it records', async () => {
    const { userId, accountId } = await seed('one');
    await seed('two');
    await setStrategy(userId, 'least_used');

    await recordUpload(userId, accountId, 5000);
    assert.equal((await chooseAccount(userId, 10))?.account.nickname, 'two');
  });
});

describe('manual', () => {
  it('follows the priority order and skips what has no room', async () => {
    const { userId } = await seed('first-choice', { quotaBytes: 100, usedBytes: 100 });
    await seed('second-choice');
    await setStrategy(userId, 'manual');

    assert.equal((await chooseAccount(userId, 5000))?.account.nickname, 'second-choice');
  });
});

describe('recordUpload', () => {
  it('adds to both the Orbit total and the used figure', async () => {
    const { userId, accountId } = await seed('target', { usedBytes: 100 });
    await recordUpload(userId, accountId, 400);

    const [row] = await db().select().from(accounts).where(eq(accounts.id, accountId));
    assert.equal(row!.uploadedViaOrbitBytes, 400);
    // Without this the dashboard drifts from reality until the next quota
    // refresh.
    assert.equal(row!.usedBytes, 500);
  });

  it('ignores an account that belongs to somebody else', async () => {
    const { userId } = await seed('mine');
    await recordUpload(userId, 'someone-elses', 400);
    // No throw, and nothing written.
  });
});

describe('asking instead of choosing', () => {
  it('declines to pick, so the caller can put the question', async () => {
    // Returning null is what makes the client show a picker rather than
    // uploading somewhere. It is not "no room" and must not be reported as it.
    const { userId } = await seed('one', { quotaBytes: 1_000_000 });
    await seed('two', { quotaBytes: 1_000_000 });

    await setStrategy(userId, 'ask');

    assert.equal(await wantsToChoose(userId), true);
    assert.equal(await chooseAccount(userId, 100), null);
  });

  it('still declines when only one account could have taken it', async () => {
    // Somebody who asked to be asked means it even when the answer looks
    // obvious today.
    const { userId } = await seed('only', { quotaBytes: 1_000_000 });
    await setStrategy(userId, 'ask');

    assert.equal(await chooseAccount(userId, 100), null);
  });

  it('leaves every other strategy picking as before', async () => {
    const { userId } = await seed('only', { quotaBytes: 1_000_000 });

    assert.equal(await wantsToChoose(userId), false);
    assert.ok(await chooseAccount(userId, 100));
  });
});
