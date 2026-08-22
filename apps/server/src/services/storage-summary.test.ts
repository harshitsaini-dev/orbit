import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

const { measureSharedDrive, storageSummary } = await import('./storage-summary.js');
const { getAdapter } = await import('@orbit/adapters');
const { createAccount } = await import('./accounts.js');
const { getLocalUser } = await import('./users.js');
const { useTestDatabase } = await import('../test-utils.js');
const { db } = await import('../lib/db.js');
const { accounts, filesMirror } = await import('@orbit/db');
const { eq } = await import('drizzle-orm');
const { nanoid } = await import('nanoid');

beforeEach(useTestDatabase);

async function seed(
  nickname: string,
  provider: 'google_drive' | 's3',
  quota: { used: number; total: number },
) {
  const user = await getLocalUser();
  const account = await createAccount({
    userId: user.id,
    provider,
    catalogueKey: provider === 's3' ? 'cloudflare_r2' : 'google_drive',
    nickname,
    remoteAccountId: nickname,
    tokens: { accessToken: 'a' },
    ...(provider === 's3' ? { s3Endpoint: 'https://x', s3Bucket: 'b', s3Region: 'auto' } : {}),
  });

  await db()
    .update(accounts)
    .set({ usedBytes: quota.used, quotaBytes: quota.total })
    .where(eq(accounts.id, account.id));

  return { userId: user.id, accountId: account.id };
}

async function mirror(accountId: string, name: string, sizeBytes: number) {
  await db().insert(filesMirror).values({
    id: nanoid(),
    accountId,
    remoteFileId: `${accountId}:${name}`,
    virtualPath: `/${name}`,
    name,
    mimeType: 'application/octet-stream',
    sizeBytes,
    isFolder: false,
    starred: false,
    modifiedAt: '2026-08-01T10:00:00.000Z',
  });
}

describe('grouping storage by what kind it is', () => {
  it('separates storage with an allowance from storage with a bill', async () => {
    // A Drive and a bucket are not the same sort of thing, and one figure
    // covering both says less than either alone.
    const { userId, accountId: drive } = await seed('drive', 'google_drive', {
      used: 12_000,
      total: 15_000,
    });
    const { accountId: bucket } = await seed('bucket', 's3', { used: 500, total: 0 });

    await mirror(drive, 'holiday.jpg', 8_000);
    await mirror(bucket, 'asset.png', 500);

    const summary = await storageSummary(userId);

    assert.deepEqual(
      summary.groups.map((group) => group.kind),
      // Allowance first: it is the half that can run out.
      ['allowance', 'metered'],
    );

    const [allowance, metered] = summary.groups;
    assert.equal(allowance!.quotaBytes, 15_000);
    assert.equal(metered!.quotaBytes, 0, 'metered storage has no allowance to be a fraction of');
    assert.equal(metered!.usedBytes, 500);
  });

  it('splits on the capability rather than on the provider name', async () => {
    // So a new adapter lands on the right side of the line without this being
    // touched.
    const { userId } = await seed('bucket', 's3', { used: 1, total: 0 });
    const summary = await storageSummary(userId);

    assert.equal(summary.groups.length, 1);
    assert.equal(summary.groups[0]!.kind, 'metered');
  });

  it('sums the file kinds across every account in a group', async () => {
    // One entry per category, not one per account: "how much of my storage is
    // photos" is a question about all of it.
    const { userId, accountId: a } = await seed('one', 'google_drive', { used: 0, total: 100 });
    const { accountId: b } = await seed('two', 'google_drive', { used: 0, total: 100 });

    await mirror(a, 'a.jpg', 300);
    await mirror(b, 'b.png', 200);
    await mirror(b, 'notes.pdf', 50);

    const [allowance] = (await storageSummary(userId)).groups;
    const images = allowance!.totals.find((total) => total.category === 'image');

    assert.equal(images!.sizeBytes, 500);
    assert.equal(images!.fileCount, 2);
  });

  it('reports the whole picture as well as the halves', async () => {
    const { userId, accountId: drive } = await seed('drive', 'google_drive', {
      used: 900,
      total: 1_000,
    });
    const { accountId: bucket } = await seed('bucket', 's3', { used: 100, total: 0 });

    await mirror(drive, 'clip.mp4', 700);
    await mirror(bucket, 'photo.jpg', 100);

    const summary = await storageSummary(userId);

    assert.equal(summary.overall.usedBytes, 1_000);
    assert.equal(summary.overall.fileCount, 2);
    assert.deepEqual(
      [...summary.overall.totals.map((total) => total.category)].sort(),
      ['image', 'video'],
    );
  });

  it('says how many accounts have nothing indexed', async () => {
    // Otherwise a breakdown missing an entire drive looks complete.
    const { userId, accountId: a } = await seed('synced', 'google_drive', { used: 5, total: 10 });
    await seed('never-synced', 'google_drive', { used: 5, total: 10 });

    await mirror(a, 'a.jpg', 5);

    assert.equal((await storageSummary(userId)).unindexed, 1);
  });

  it('does not count a folder as a file', async () => {
    const { userId, accountId: a } = await seed('drive', 'google_drive', { used: 0, total: 10 });

    await mirror(a, 'a.jpg', 5);
    await db().insert(filesMirror).values({
      id: nanoid(),
      accountId: a,
      remoteFileId: 'folder',
      virtualPath: '/photos',
      name: 'photos',
      mimeType: 'application/x-directory',
      sizeBytes: 0,
      isFolder: true,
      starred: false,
      modifiedAt: '2026-08-01T10:00:00.000Z',
    });

    assert.equal((await storageSummary(userId)).overall.fileCount, 1);
  });

  it('never mixes in another user\'s storage', async () => {
    const { userId } = await seed('mine', 'google_drive', { used: 5, total: 10 });

    assert.equal((await storageSummary(userId)).groups.length, 1);
    assert.deepEqual((await storageSummary('somebody-else')).groups, []);
  });
});

describe('measuring a shared drive', () => {
  it('sums what the drive holds, and remembers it', async () => {
    // Listing a drive of any size takes a minute, so measuring twice for one
    // answer is not something to do casually.
    const { userId, accountId } = await seed('drive', 'google_drive', { used: 0, total: 100 });

    let calls = 0;
    const drive = getAdapter('google_drive');
    (drive as unknown as Record<string, unknown>).listAllUnder = async () => {
      calls += 1;
      return {
        files: [
          { name: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 300, isFolder: false },
          { name: 'b.pdf', mimeType: 'application/pdf', sizeBytes: 200, isFolder: false },
        ],
      };
    };

    const first = await measureSharedDrive(userId, accountId, 'drive-1');
    assert.equal(first!.sizeBytes, 500);
    assert.equal(first!.fileCount, 2);
    assert.equal(first!.partial, false);

    await measureSharedDrive(userId, accountId, 'drive-1');
    assert.equal(calls, 1, 'the second answer comes from what was already measured');
  });

  it('says so when the listing stopped early', async () => {
    // A truncated total that looks whole is worse than one that admits it.
    const { userId, accountId } = await seed('drive', 'google_drive', { used: 0, total: 100 });

    const drive = getAdapter('google_drive');
    (drive as unknown as Record<string, unknown>).listAllUnder = async () => ({
      // Always another page, so the cap is what stops it.
      files: [{ name: 'a.bin', mimeType: 'application/octet-stream', sizeBytes: 1, isFolder: false }],
      nextPageToken: 'more',
    });

    const measured = await measureSharedDrive(userId, accountId, 'endless');
    assert.equal(measured!.partial, true);
  });

  it('declines for a provider that cannot list a drive in one pass', async () => {
    // Walking a folder tree a request at a time is not a reasonable fallback,
    // and a caller is better off knowing it cannot be done.
    const { userId, accountId } = await seed('bucket', 's3', { used: 0, total: 0 });
    assert.equal(await measureSharedDrive(userId, accountId, 'anything'), null);
  });
});
