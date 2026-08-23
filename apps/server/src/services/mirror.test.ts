import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

const { useTestDatabase } = await import('../test-utils.js');
const { createAccount } = await import('./accounts.js');
const { getLocalUser } = await import('./users.js');
const {
  forgetWithSubtrees,
  listFolderFromMirror,
  mirrorCoverage,
  rememberInMirror,
  renameInMirror,
  searchMirror,
  starInMirror,
} = await import('./mirror.js');

let accountId: string;

/** Minimal file, so each test states only what it is actually about. */
function file(
  name: string,
  virtualPath: string,
  extra: Record<string, unknown> = {},
): Parameters<typeof rememberInMirror>[1][number] {
  return {
    remoteId: virtualPath,
    name,
    virtualPath,
    mimeType: 'application/octet-stream',
    sizeBytes: 10,
    isFolder: false,
    starred: false,
    modifiedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

beforeEach(async () => {
  await useTestDatabase();

  const user = await getLocalUser();
  const account = await createAccount({
    userId: user.id,
    provider: 'google_drive',
    catalogueKey: 'google_drive',
    nickname: 'me@example.com',
    tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000 },
  });
  accountId = account.id;
});

describe('browsing the mirror', () => {
  it('returns the children of a folder and not its grandchildren', async () => {
    await rememberInMirror(accountId, [
      file('a.txt', '/Photos/a.txt'),
      file('b.txt', '/Photos/b.txt'),
      file('deep.txt', '/Photos/2026/deep.txt'),
      file('elsewhere.txt', '/Docs/elsewhere.txt'),
    ]);

    const page = await listFolderFromMirror(accountId, '/Photos');

    assert.deepEqual(
      page.files.map((entry) => entry.name),
      ['a.txt', 'b.txt'],
    );
  });

  it('lists the root without swallowing everything beneath it', async () => {
    await rememberInMirror(accountId, [
      file('top.txt', '/top.txt'),
      file('under.txt', '/Photos/under.txt'),
    ]);

    const page = await listFolderFromMirror(accountId, '/');

    assert.deepEqual(
      page.files.map((entry) => entry.name),
      ['top.txt'],
    );
  });

  it('puts folders before files, the way a file manager does', async () => {
    await rememberInMirror(accountId, [
      file('a-file.txt', '/a-file.txt'),
      file('z-folder', '/z-folder', { isFolder: true }),
    ]);

    const page = await listFolderFromMirror(accountId, '/');

    assert.deepEqual(
      page.files.map((entry) => entry.name),
      ['z-folder', 'a-file.txt'],
    );
  });

  /*
   * The distinction the listing route depends on. An account with no rows must
   * be told apart from a folder with no files, because the first has to fall
   * through to the provider and the second must not.
   */
  it('reports no coverage for an account that has never synced', async () => {
    assert.equal((await mirrorCoverage(accountId)).rows, 0);

    await rememberInMirror(accountId, [file('one.txt', '/one.txt')]);

    assert.equal((await mirrorCoverage(accountId)).rows, 1);
  });

  it('upserts rather than duplicating a file seen twice', async () => {
    await rememberInMirror(accountId, [file('one.txt', '/one.txt')]);
    await rememberInMirror(accountId, [file('renamed.txt', '/renamed.txt', { remoteId: '/one.txt' })]);

    const page = await listFolderFromMirror(accountId, '/');

    assert.equal(page.files.length, 1);
    assert.equal(page.files[0]?.name, 'renamed.txt');
  });
});

describe('searching the mirror', () => {
  it('matches a name by prefix, so it answers before the word is finished', async () => {
    await rememberInMirror(accountId, [
      file('Quarterly report.pdf', '/Quarterly report.pdf'),
      file('holiday.jpg', '/holiday.jpg'),
    ]);

    const found = await searchMirror({ text: 'repo' }, [accountId]);

    assert.deepEqual(
      found.files.map((entry) => entry.name),
      ['Quarterly report.pdf'],
    );
  });

  it('does not match a file that was deleted', async () => {
    await rememberInMirror(accountId, [file('report.pdf', '/report.pdf')]);
    await forgetWithSubtrees(accountId, ['/report.pdf']);

    const found = await searchMirror({ text: 'report' }, [accountId]);

    assert.equal(found.files.length, 0);
  });

  it('survives a term made of characters FTS5 would read as operators', async () => {
    await rememberInMirror(accountId, [file('a "quoted" name.txt', '/a "quoted" name.txt')]);

    const found = await searchMirror({ text: '"quoted"' }, [accountId]);

    assert.equal(found.files.length, 1);
  });

  it('finds nothing rather than throwing when the term is all punctuation', async () => {
    await rememberInMirror(accountId, [file('report.pdf', '/report.pdf')]);

    const found = await searchMirror({ text: '???' }, [accountId]);

    // No usable term means no name criterion, so the other filters decide.
    assert.equal(found.files.length, 1);
  });

  /*
   * Null means "this provider does not report a creation date", so a created
   * filter has to exclude those rows rather than treat them as the epoch -
   * which would put every Dropbox file in "older than a year".
   */
  it('excludes files with no created date from a created filter', async () => {
    await rememberInMirror(accountId, [
      file('dated.txt', '/dated.txt', { createdAt: '2026-02-01T00:00:00.000Z' }),
      file('undated.txt', '/undated.txt'),
    ]);

    const found = await searchMirror({ createdBefore: '2026-06-01T00:00:00.000Z' }, [accountId]);

    assert.deepEqual(
      found.files.map((entry) => entry.name),
      ['dated.txt'],
    );
  });

  it('restricts to a subtree when asked', async () => {
    await rememberInMirror(accountId, [
      file('in.txt', '/Photos/in.txt'),
      file('out.txt', '/Docs/out.txt'),
    ]);

    const found = await searchMirror({ text: 'txt', underPath: '/Photos' }, [accountId]);

    assert.deepEqual(
      found.files.map((entry) => entry.name),
      ['in.txt'],
    );
  });

  it('returns nothing for an account it was not given', async () => {
    await rememberInMirror(accountId, [file('report.pdf', '/report.pdf')]);

    const found = await searchMirror({ text: 'report' }, [accountId], undefined);
    const scoped = await searchMirror({ text: 'report', accountId: 'someone-else' }, [accountId]);

    assert.equal(found.files.length, 1);
    assert.equal(scoped.files.length, 0);
  });
});

describe('keeping the mirror true after a change', () => {
  /*
   * The failure this exists for: a folder's path is a prefix of everything
   * below it, so renaming one and stopping there leaves its whole subtree
   * filed under a directory that no longer exists.
   */
  it('rewrites the paths underneath a renamed folder', async () => {
    await rememberInMirror(accountId, [
      file('Photos', '/Photos', { isFolder: true }),
      file('a.jpg', '/Photos/a.jpg'),
      file('b.jpg', '/Photos/2026/b.jpg'),
    ]);

    await renameInMirror(accountId, '/Photos', 'Pictures');

    const page = await listFolderFromMirror(accountId, '/Pictures');
    assert.deepEqual(
      page.files.map((entry) => entry.virtualPath),
      ['/Pictures/a.jpg'],
    );

    const deep = await listFolderFromMirror(accountId, '/Pictures/2026');
    assert.deepEqual(
      deep.files.map((entry) => entry.virtualPath),
      ['/Pictures/2026/b.jpg'],
    );
  });

  it('renames a file without touching anything that shares its prefix', async () => {
    await rememberInMirror(accountId, [
      file('note.txt', '/note.txt'),
      file('notes.txt', '/notes.txt'),
    ]);

    await renameInMirror(accountId, '/note.txt', 'renamed.txt');

    const page = await listFolderFromMirror(accountId, '/');
    assert.deepEqual(
      page.files.map((entry) => entry.name).sort(),
      ['notes.txt', 'renamed.txt'],
    );
  });

  it('drops what was inside a deleted folder', async () => {
    await rememberInMirror(accountId, [
      file('Photos', '/Photos', { isFolder: true }),
      file('a.jpg', '/Photos/a.jpg'),
      file('keep.txt', '/keep.txt'),
    ]);

    await forgetWithSubtrees(accountId, ['/Photos']);

    assert.equal((await mirrorCoverage(accountId)).rows, 1);
    assert.equal((await searchMirror({ text: 'a' }, [accountId])).files.length, 0);
  });

  it('flips a star in place', async () => {
    await rememberInMirror(accountId, [file('one.txt', '/one.txt')]);

    await starInMirror(accountId, '/one.txt', true);

    const page = await listFolderFromMirror(accountId, '/');
    assert.equal(page.files[0]?.starred, true);
  });
});
