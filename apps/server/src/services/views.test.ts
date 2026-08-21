import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

const { listWorkspaceView } = await import('./views.js');
const { createAccount } = await import('./accounts.js');
const { getLocalUser } = await import('./users.js');
const { useTestDatabase } = await import('../test-utils.js');
const { getAdapter } = await import('@orbit/adapters');

const drive = getAdapter('google_drive');
const dropbox = getAdapter('dropbox');

const pristine = {
  drive: { listView: drive.listView.bind(drive), capabilities: { ...drive.capabilities } },
  dropbox: { listView: dropbox.listView.bind(dropbox), capabilities: { ...dropbox.capabilities } },
};

function restore(): void {
  (drive as unknown as Record<string, unknown>).listView = pristine.drive.listView;
  Object.assign(drive.capabilities, pristine.drive.capabilities);
  (dropbox as unknown as Record<string, unknown>).listView = pristine.dropbox.listView;
  Object.assign(dropbox.capabilities, pristine.dropbox.capabilities);
}

function file(name: string, modifiedAt: string, extra: Record<string, unknown> = {}) {
  return {
    remoteId: name,
    name,
    virtualPath: `/${name}`,
    mimeType: 'text/plain',
    sizeBytes: 10,
    isFolder: false,
    starred: false,
    modifiedAt,
    ...extra,
  };
}

async function seed(provider: 'google_drive' | 'dropbox', nickname: string) {
  const user = await getLocalUser();
  const account = await createAccount({
    userId: user.id,
    provider,
    catalogueKey: provider,
    nickname,
    tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000 },
  });
  return { userId: user.id, accountId: account.id };
}

beforeEach(async () => {
  await useTestDatabase();
  restore();
});

describe('listWorkspaceView', () => {
  it('merges files from every account into one chronological list', async () => {
    // This is the whole point: "recent" must mean recent everywhere, not recent
    // in whichever account happens to be selected.
    (drive as unknown as Record<string, unknown>).listView = async () => ({
      files: [file('drive-old.txt', '2026-01-01T00:00:00.000Z'), file('drive-new.txt', '2026-03-01T00:00:00.000Z')],
    });
    (dropbox as unknown as Record<string, unknown>).listView = async () => ({
      files: [file('dropbox-middle.txt', '2026-02-01T00:00:00.000Z')],
    });

    const { userId } = await seed('google_drive', 'drive@example.com');
    await seed('dropbox', 'dropbox@example.com');

    const result = await listWorkspaceView(userId, 'recent');

    assert.deepEqual(
      result.files.map((f) => f.name),
      ['drive-new.txt', 'dropbox-middle.txt', 'drive-old.txt'],
      'newest first, regardless of which account it came from',
    );
  });

  it('labels every file with the account it came from', async () => {
    (drive as unknown as Record<string, unknown>).listView = async () => ({ files: [file('a.txt', '2026-01-01T00:00:00.000Z')] });

    const { userId } = await seed('google_drive', 'me@example.com');
    const result = await listWorkspaceView(userId, 'recent');

    assert.equal(result.files[0]!.accountNickname, 'me@example.com');
    assert.equal(result.files[0]!.provider, 'google_drive');
    assert.ok(result.files[0]!.accountId);
  });

  it('sorts starred by name rather than by date', async () => {
    (drive as unknown as Record<string, unknown>).listView = async () => ({
      files: [file('zebra.txt', '2026-03-01T00:00:00.000Z'), file('apple.txt', '2026-01-01T00:00:00.000Z')],
    });

    const { userId } = await seed('google_drive', 'me@example.com');
    const result = await listWorkspaceView(userId, 'starred');

    assert.deepEqual(result.files.map((f) => f.name), ['apple.txt', 'zebra.txt']);
  });

  it('reports an account it could not reach instead of quietly dropping it', async () => {
    // A partial result that looks complete is worse than no result.
    (drive as unknown as Record<string, unknown>).listView = async () => ({ files: [file('a.txt', '2026-01-01T00:00:00.000Z')] });
    (dropbox as unknown as Record<string, unknown>).listView = async () => {
      throw new Error('needs_reauth');
    };

    const { userId } = await seed('google_drive', 'drive@example.com');
    await seed('dropbox', 'dropbox@example.com');

    const result = await listWorkspaceView(userId, 'recent');

    assert.equal(result.files.length, 1, 'the healthy account still contributes');
    assert.equal(result.problems.length, 1);
    assert.equal(result.problems[0]!.nickname, 'dropbox@example.com');
    assert.match(result.problems[0]!.reason, /reconnect/);
  });

  it('names the providers that cannot offer a view, rather than omitting them', async () => {
    drive.capabilities.sharedWithMe = false;

    const { userId } = await seed('google_drive', 'me@example.com');
    const result = await listWorkspaceView(userId, 'shared');

    assert.equal(result.files.length, 0);
    assert.deepEqual(result.unsupported.map((entry) => entry.nickname), ['me@example.com']);
    assert.equal(result.problems.length, 0, 'unsupported is not the same as broken');
  });

  it('gates each view on its own capability', async () => {
    let asked: string | null = null;
    (drive as unknown as Record<string, unknown>).listView = async (_t: unknown, view: string) => {
      asked = view;
      return { files: [] };
    };

    drive.capabilities.star = false;
    const { userId } = await seed('google_drive', 'me@example.com');

    await listWorkspaceView(userId, 'starred');
    assert.equal(asked, null, 'a provider that cannot star must not be asked for starred files');

    await listWorkspaceView(userId, 'recent');
    assert.equal(asked, 'recent', 'but recent is still fair game');
  });

  it('caps the merged list', async () => {
    (drive as unknown as Record<string, unknown>).listView = async () => ({
      files: Array.from({ length: 50 }, (_, i) => file(`f${i}.txt`, '2026-01-01T00:00:00.000Z')),
    });

    const { userId } = await seed('google_drive', 'me@example.com');
    const result = await listWorkspaceView(userId, 'recent', 10);

    assert.equal(result.files.length, 10);
  });

  it('returns an empty view when nothing is connected', async () => {
    const user = await getLocalUser();
    const result = await listWorkspaceView(user.id, 'recent');

    assert.deepEqual(result, { files: [], problems: [], unsupported: [] });
  });
});
