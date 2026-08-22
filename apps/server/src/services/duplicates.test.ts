import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

const { findDuplicates, ignoreGroup, listIgnored, unignoreGroup } = await import(
  './duplicates.js'
);
const { createAccount } = await import('./accounts.js');
const { findOrCreateByEmail, getLocalUser } = await import('./users.js');
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

describe('saying a set is not duplicates', () => {
  it('stops raising it, without deleting anything', async () => {
    // Two files can share a size and a name and be genuinely different. A
    // report that insists otherwise every time it is opened is a report people
    // stop reading.
    const { userId, accountId: a } = await seedAccount('one@example.com');
    const { accountId: b } = await seedAccount('two@example.com');

    await mirror(a, { name: 'contract.pdf', checksum: 'same' });
    await mirror(b, { name: 'contract.pdf', checksum: 'same' });

    const before = await findDuplicates(userId);
    assert.equal(before.groups.length, 1);

    await ignoreGroup(userId, before.groups[0]!.key, 'contract.pdf');

    const after = await findDuplicates(userId);
    assert.deepEqual(after.groups, []);
    assert.equal(after.ignored, 1, 'and the page can say so rather than looking empty');

    // The files are untouched: they are still counted in the scan.
    assert.equal(after.scanned, before.scanned);
  });

  it('recognises the same set again after a re-scan', async () => {
    // The key is built from what made it a set, not from the files in it, so a
    // dismissal has to survive the report being rebuilt from scratch.
    const { userId, accountId: a } = await seedAccount('one@example.com');
    const { accountId: b } = await seedAccount('two@example.com');
    const { accountId: c } = await seedAccount('three@example.com');

    await mirror(a, { name: 'clip.mp4', checksum: 'x1' });
    await mirror(b, { name: 'clip.mp4', checksum: 'x1' });

    const first = await findDuplicates(userId);
    await ignoreGroup(userId, first.groups[0]!.key, 'clip.mp4');

    // A third copy turns up. It is the same set, and it stays dismissed.
    await mirror(c, { name: 'clip.mp4', checksum: 'x1' });

    assert.deepEqual((await findDuplicates(userId)).groups, []);
  });

  it('dismisses a guess without touching a certain set of the same files', async () => {
    // The two kinds are keyed differently on purpose: dismissing "same size and
    // name" must not silence a checksum that actually agrees.
    const { userId, accountId: a } = await seedAccount('one@example.com');
    const { accountId: b } = await seedAccount('two@example.com');

    await mirror(a, { name: 'notes.txt', checksum: null });
    await mirror(b, { name: 'notes.txt', checksum: null });
    await mirror(a, { name: 'photo.jpg', checksum: 'p1' });
    await mirror(b, { name: 'photo2.jpg', checksum: 'p1' });

    const before = await findDuplicates(userId);
    const guess = before.groups.find((g) => g.kind === 'probable')!;

    await ignoreGroup(userId, guess.key, 'notes.txt');

    const after = await findDuplicates(userId);
    assert.deepEqual(
      after.groups.map((g) => g.kind),
      ['identical'],
    );
  });

  it('shows them again when asked', async () => {
    // A dismissal that cannot be undone is a decision people are right to avoid
    // making.
    const { userId, accountId: a } = await seedAccount('one@example.com');
    const { accountId: b } = await seedAccount('two@example.com');

    await mirror(a, { name: 'report.pdf', checksum: 'r1' });
    await mirror(b, { name: 'report.pdf', checksum: 'r1' });

    const found = await findDuplicates(userId);
    await ignoreGroup(userId, found.groups[0]!.key, 'report.pdf');

    const shown = await findDuplicates(userId, { includeIgnored: true });
    assert.equal(shown.groups.length, 1);
    assert.equal(shown.ignored, 0, 'nothing is being hidden in this view');

    assert.equal(await unignoreGroup(userId, found.groups[0]!.key), true);
    assert.equal((await findDuplicates(userId)).groups.length, 1);
  });

  it('treats dismissing the same set twice as a no-op', async () => {
    const { userId, accountId: a } = await seedAccount('one@example.com');
    const { accountId: b } = await seedAccount('two@example.com');

    await mirror(a, { name: 'a.bin', checksum: 'k' });
    await mirror(b, { name: 'a.bin', checksum: 'k' });

    const key = (await findDuplicates(userId)).groups[0]!.key;
    await ignoreGroup(userId, key, 'a.bin');
    await ignoreGroup(userId, key, 'a.bin');

    assert.equal((await listIgnored(userId)).length, 1);
  });

  it('reports nothing removed for a set that was never dismissed', async () => {
    const { userId } = await seedAccount('one@example.com');
    assert.equal(await unignoreGroup(userId, 'identical:nope:1'), false);
  });

  it('keeps one person\'s dismissals out of another\'s report', async () => {
    const { userId, accountId: a } = await seedAccount('one@example.com');
    const { accountId: b } = await seedAccount('two@example.com');

    await mirror(a, { name: 'shared.iso', checksum: 's1' });
    await mirror(b, { name: 'shared.iso', checksum: 's1' });

    const key = (await findDuplicates(userId)).groups[0]!.key;

    // A real second user, not an invented id: the row points at users.id, and
    // a made-up one is rejected by the foreign key rather than proving
    // anything about scoping.
    const other = await findOrCreateByEmail('other@example.com');
    await ignoreGroup(other.id, key, 'shared.iso');

    assert.equal((await findDuplicates(userId)).groups.length, 1);
    assert.deepEqual(await listIgnored(userId), []);
  });
});

describe('saying which drives were searched', () => {
  it('names every connected drive, including one with nothing indexed', async () => {
    // A drive silently missing from "what was searched" is exactly what this is
    // here to prevent: the scan reads the mirror, so a drive that has never
    // been synced contributes nothing and would otherwise vanish from the
    // report rather than showing a zero.
    const { userId, accountId: a } = await seedAccount('one@example.com');
    await seedAccount('never-synced@example.com');

    await mirror(a, { name: 'a.bin', checksum: 'k1' });
    await mirror(a, { name: 'b.bin', checksum: 'k2' });

    const { drives } = await findDuplicates(userId);

    assert.deepEqual(
      drives.map((drive) => [drive.nickname, drive.files]),
      [
        ['one@example.com', 2],
        ['never-synced@example.com', 0],
      ],
    );
  });

  it('counts files rather than folders', async () => {
    const { userId, accountId: a } = await seedAccount('one@example.com');

    await mirror(a, { name: 'photos', isFolder: true });
    await mirror(a, { name: 'a.bin', checksum: 'k1' });

    assert.equal((await findDuplicates(userId)).drives[0]!.files, 1);
  });

  it('never counts another user\'s drive', async () => {
    const { userId } = await seedAccount('one@example.com');
    const other = await findOrCreateByEmail('other@example.com');

    await createAccount({
      userId: other.id,
      provider: 'google_drive',
      catalogueKey: 'google_drive',
      nickname: 'theirs@example.com',
      remoteAccountId: 'theirs@example.com',
      tokens: { accessToken: 'a' },
    });

    assert.deepEqual(
      (await findDuplicates(userId)).drives.map((drive) => drive.nickname),
      ['one@example.com'],
    );
  });
});
