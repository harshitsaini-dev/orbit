import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

const { searchWorkspace } = await import('./search.js');
const { createAccount } = await import('./accounts.js');
const { getLocalUser } = await import('./users.js');
const { useTestDatabase } = await import('../test-utils.js');
const { getAdapter } = await import('@orbit/adapters');

const drive = getAdapter('google_drive');
const pristine = { search: drive.search.bind(drive), capabilities: { ...drive.capabilities } };

function restore(): void {
  (drive as unknown as Record<string, unknown>).search = pristine.search;
  Object.assign(drive.capabilities, pristine.capabilities);
}

function file(name: string, mimeType = 'text/plain', extra: Record<string, unknown> = {}) {
  return {
    remoteId: name,
    name,
    virtualPath: `/${name}`,
    mimeType,
    sizeBytes: 10,
    isFolder: false,
    starred: false,
    modifiedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

async function seed() {
  const user = await getLocalUser();
  const account = await createAccount({
    userId: user.id,
    provider: 'google_drive',
    catalogueKey: 'google_drive',
    nickname: 'me@example.com',
    tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000 },
  });
  return { userId: user.id, accountId: account.id };
}

beforeEach(async () => {
  await useTestDatabase();
  restore();
});

describe('searchWorkspace', () => {
  it('passes the whole query to the provider, not just the text', async () => {
    let seen: unknown;
    (drive as unknown as Record<string, unknown>).search = async (_t: unknown, query: unknown) => {
      seen = query;
      return { files: [] };
    };

    const { userId } = await seed();
    await searchWorkspace(userId, {
      text: 'report',
      underPath: '/Documents',
      modifiedAfter: '2026-01-01T00:00:00.000Z',
      starredOnly: true,
    });

    assert.deepEqual(seen, {
      text: 'report',
      underPath: '/Documents',
      modifiedAfter: '2026-01-01T00:00:00.000Z',
      starredOnly: true,
    });
  });

  it('applies the category filter itself rather than trusting the provider', async () => {
    // Orbit's classification reads the extension when the mime type is useless,
    // which no provider query language can express - so it has to be applied here
    // or the same filter would mean different things on different providers.
    (drive as unknown as Record<string, unknown>).search = async () => ({
      files: [
        file('photo.jpg', 'image/jpeg'),
        file('clip.mp4', 'application/octet-stream'),
        file('notes.txt', 'text/plain'),
      ],
    });

    const { userId } = await seed();
    const result = await searchWorkspace(userId, { text: 'x', categories: ['video'] });

    assert.deepEqual(result.files.map((f) => f.name), ['clip.mp4'], 'matched by extension, not mime');
  });

  it('excludes folders when a category filter is set, but keeps them otherwise', async () => {
    (drive as unknown as Record<string, unknown>).search = async () => ({
      files: [file('Photos', 'application/vnd.google-apps.folder', { isFolder: true }), file('a.jpg', 'image/jpeg')],
    });

    const { userId } = await seed();

    const named = await searchWorkspace(userId, { text: 'a' });
    assert.equal(named.files.length, 2, 'a folder matches a name search like anything else');

    const typed = await searchWorkspace(userId, { text: 'a', categories: ['image'] });
    assert.deepEqual(typed.files.map((f) => f.name), ['a.jpg']);
  });

  it('labels each result with the account it came from', async () => {
    (drive as unknown as Record<string, unknown>).search = async () => ({ files: [file('a.txt')] });

    const { userId } = await seed();
    const result = await searchWorkspace(userId, { text: 'a' });

    assert.equal(result.files[0]!.accountNickname, 'me@example.com');
    assert.equal(result.files[0]!.provider, 'google_drive');
  });

  it('reports an account that could not be searched', async () => {
    (drive as unknown as Record<string, unknown>).search = async () => {
      throw new Error('needs_reauth');
    };

    const { userId } = await seed();
    const result = await searchWorkspace(userId, { text: 'a' });

    assert.equal(result.files.length, 0);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0]!.reason, /reconnect/);
  });

  it('names a provider that cannot search at all', async () => {
    drive.capabilities.search = false;

    const { userId } = await seed();
    const result = await searchWorkspace(userId, { text: 'a' });

    assert.deepEqual(result.unsupported.map((entry) => entry.nickname), ['me@example.com']);
  });

  it('can be scoped to one account', async () => {
    let calls = 0;
    (drive as unknown as Record<string, unknown>).search = async () => {
      calls += 1;
      return { files: [] };
    };

    const { userId, accountId } = await seed();
    await createAccount({
      userId,
      provider: 'google_drive',
      catalogueKey: 'google_drive',
      nickname: 'second@example.com',
      tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000 },
    });

    await searchWorkspace(userId, { text: 'a', accountId });
    assert.equal(calls, 1, 'only the named account should be searched');
  });

  it('returns results newest first', async () => {
    (drive as unknown as Record<string, unknown>).search = async () => ({
      files: [
        file('old.txt', 'text/plain', { modifiedAt: '2026-01-01T00:00:00.000Z' }),
        file('new.txt', 'text/plain', { modifiedAt: '2026-06-01T00:00:00.000Z' }),
      ],
    });

    const { userId } = await seed();
    const result = await searchWorkspace(userId, { text: 'x' });

    assert.deepEqual(result.files.map((f) => f.name), ['new.txt', 'old.txt']);
  });
});
