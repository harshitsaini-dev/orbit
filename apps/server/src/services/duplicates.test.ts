import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

const { findDuplicates } = await import('./duplicates.js');
const { createAccount } = await import('./accounts.js');
const { getLocalUser } = await import('./users.js');
const { useTestDatabase } = await import('../test-utils.js');
const { db } = await import('../lib/db.js');
const { filesMirror } = await import('@orbit/db');
const { nanoid } = await import('nanoid');

beforeEach(useTestDatabase);

async function seedAccount(nickname: string) {
  const user = await getLocalUser();
  const account = await createAccount({
    userId: user.id,
    provider: 'google_drive',
    catalogueKey: 'google_drive',
    nickname,
    remoteAccountId: nickname,
    tokens: {
      accessToken: 'access-sentinel',
      refreshToken: 'refresh-sentinel',
      expiresAt: Date.now() + 3_600_000,
    },
  });
  return { userId: user.id, accountId: account.id };
}

/** One megabyte, so nothing is filtered out for being trivially small. */
const BIG = 1024 * 1024;

async function mirror(
  accountId: string,
  file: { name: string; sizeBytes?: number; checksum?: string | null; isFolder?: boolean },
) {
  await db()
    .insert(filesMirror)
    .values({
      id: nanoid(),
      accountId,
      remoteFileId: `${accountId}:${file.name}`,
      virtualPath: `/${file.name}`,
      name: file.name,
      mimeType: 'application/octet-stream',
      sizeBytes: file.sizeBytes ?? BIG,
      isFolder: file.isFolder ?? false,
      starred: false,
      checksum: file.checksum ?? null,
      modifiedAt: '2026-08-01T10:00:00.000Z',
    });
}

describe('finding the same file twice', () => {
  it('calls a matching checksum identical', async () => {
    const { userId, accountId: a } = await seedAccount('one@example.com');
    const { accountId: b } = await seedAccount('two@example.com');

    await mirror(a, { name: 'holiday.jpg', checksum: 'abc123' });
    await mirror(b, { name: 'holiday-copy.jpg', checksum: 'abc123' });

    const { groups } = await findDuplicates(userId);

    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.kind, 'identical');
    // Different names, same bytes: only a checksum can say that.
    assert.deepEqual(
      groups[0]!.files.map((file) => file.name).sort(),
      ['holiday-copy.jpg', 'holiday.jpg'],
    );
  });

  it('calls a matching size and name probable, not identical', async () => {
    // Presenting a guess as a certainty is how somebody deletes their only copy.
    const { userId, accountId: a } = await seedAccount('one@example.com');
    const { accountId: b } = await seedAccount('two@example.com');

    await mirror(a, { name: 'report.pdf' });
    await mirror(b, { name: 'report.pdf' });

    const { groups } = await findDuplicates(userId);

    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.kind, 'probable');
  });

  it('does not report a file twice, once proven and once guessed', async () => {
    const { userId, accountId: a } = await seedAccount('one@example.com');
    const { accountId: b } = await seedAccount('two@example.com');

    await mirror(a, { name: 'same.bin', checksum: 'abc123' });
    await mirror(b, { name: 'same.bin', checksum: 'abc123' });

    const { groups } = await findDuplicates(userId);

    assert.equal(groups.length, 1, 'the pair matches on both, and is one group');
    assert.equal(groups[0]!.kind, 'identical');
  });

  it('says how much deleting the extras would free', async () => {
    const { userId, accountId: a } = await seedAccount('one@example.com');
    const { accountId: b } = await seedAccount('two@example.com');
    const { accountId: c } = await seedAccount('three@example.com');

    for (const account of [a, b, c]) {
      await mirror(account, { name: 'big.iso', sizeBytes: 3 * BIG, checksum: 'iso-hash' });
    }

    const { groups } = await findDuplicates(userId);

    // Three copies, so two are spare - not three.
    assert.equal(groups[0]!.reclaimableBytes, 6 * BIG);
  });

  it('puts the biggest saving first', async () => {
    const { userId, accountId: a } = await seedAccount('one@example.com');
    const { accountId: b } = await seedAccount('two@example.com');

    await mirror(a, { name: 'small.bin', sizeBytes: BIG, checksum: 'small' });
    await mirror(b, { name: 'small.bin', sizeBytes: BIG, checksum: 'small' });
    await mirror(a, { name: 'huge.bin', sizeBytes: 50 * BIG, checksum: 'huge' });
    await mirror(b, { name: 'huge.bin', sizeBytes: 50 * BIG, checksum: 'huge' });

    const { groups } = await findDuplicates(userId);
    assert.equal(groups[0]!.files[0]!.name, 'huge.bin');
  });
});

describe('what is deliberately not matched', () => {
  it('ignores a multipart ETag, which is not a hash of the content', async () => {
    // S3 builds it from the part hashes and appends the count, so two identical
    // files uploaded with different part sizes get different ETags. It is not
    // comparable with anything.
    const { userId, accountId: a } = await seedAccount('one@example.com');
    const { accountId: b } = await seedAccount('two@example.com');

    await mirror(a, { name: 'a.bin', checksum: 'abc-3' });
    await mirror(b, { name: 'b.bin', checksum: 'abc-3' });

    const { groups } = await findDuplicates(userId);
    assert.deepEqual(groups, [], 'a multipart ETag must never prove anything');
  });

  it('ignores files too small to be worth reporting', async () => {
    // A hundred identical 12-byte configs would bury the ones that matter.
    const { userId, accountId: a } = await seedAccount('one@example.com');
    const { accountId: b } = await seedAccount('two@example.com');

    await mirror(a, { name: 'tiny.txt', sizeBytes: 12, checksum: 'same' });
    await mirror(b, { name: 'tiny.txt', sizeBytes: 12, checksum: 'same' });

    assert.deepEqual((await findDuplicates(userId)).groups, []);
  });

  it('does not match two different files that share a size', async () => {
    const { userId, accountId: a } = await seedAccount('one@example.com');
    const { accountId: b } = await seedAccount('two@example.com');

    await mirror(a, { name: 'alpha.bin' });
    await mirror(b, { name: 'beta.bin' });

    assert.deepEqual((await findDuplicates(userId)).groups, []);
  });

  it('ignores folders', async () => {
    const { userId, accountId: a } = await seedAccount('one@example.com');
    const { accountId: b } = await seedAccount('two@example.com');

    await mirror(a, { name: 'Photos', isFolder: true });
    await mirror(b, { name: 'Photos', isFolder: true });

    assert.deepEqual((await findDuplicates(userId)).groups, []);
  });

  it('never looks at another user\'s files', async () => {
    const { userId, accountId: a } = await seedAccount('mine@example.com');
    await mirror(a, { name: 'x.bin', checksum: 'shared' });

    const { groups } = await findDuplicates(userId);
    assert.deepEqual(groups, [], 'one copy is not a duplicate');
  });
});

describe('reporting', () => {
  it('counts what was scanned and how much of it had no usable checksum', async () => {
    // The second number is what tells someone why the answer is full of guesses
    // rather than certainties.
    const { userId, accountId: a } = await seedAccount('one@example.com');

    await mirror(a, { name: 'hashed.bin', checksum: 'abc' });
    await mirror(a, { name: 'unhashed.bin', checksum: null });
    await mirror(a, { name: 'multipart.bin', checksum: 'abc-2' });

    const result = await findDuplicates(userId);

    assert.equal(result.scanned, 3);
    assert.equal(result.withoutChecksum, 2);
  });
});
