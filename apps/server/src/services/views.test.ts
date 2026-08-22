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
const onedrive = getAdapter('onedrive');

const pristine = {
  drive: { listView: drive.listView.bind(drive), capabilities: { ...drive.capabilities } },
  onedrive: { listView: onedrive.listView.bind(onedrive), capabilities: { ...onedrive.capabilities } },
};

function restore(): void {
  (drive as unknown as Record<string, unknown>).listView = pristine.drive.listView;
  Object.assign(drive.capabilities, pristine.drive.capabilities);
  (onedrive as unknown as Record<string, unknown>).listView = pristine.onedrive.listView;
  Object.assign(onedrive.capabilities, pristine.onedrive.capabilities);
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

async function seed(
  provider: 'google_drive' | 'onedrive',
  nickname: string,
  accessToken = 'access-token-sentinel',
) {
  const user = await getLocalUser();
  const account = await createAccount({
    userId: user.id,
    provider,
    catalogueKey: provider,
    nickname,
    // Named per account where a test needs to tell which one was asked.
    remoteAccountId: nickname,
    tokens: {
      accessToken,
      refreshToken: 'refresh-token-sentinel',
      expiresAt: Date.now() + 3_600_000,
    },
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
    (onedrive as unknown as Record<string, unknown>).listView = async () => ({
      files: [file('onedrive-middle.txt', '2026-02-01T00:00:00.000Z')],
    });

    const { userId } = await seed('google_drive', 'drive@example.com');
    await seed('onedrive', 'onedrive@example.com');

    const result = await listWorkspaceView(userId, 'recent');

    assert.deepEqual(
      result.files.map((f) => f.name),
      ['drive-new.txt', 'onedrive-middle.txt', 'drive-old.txt'],
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
    (onedrive as unknown as Record<string, unknown>).listView = async () => {
      throw new Error('needs_reauth');
    };

    const { userId } = await seed('google_drive', 'drive@example.com');
    await seed('onedrive', 'onedrive@example.com');

    const result = await listWorkspaceView(userId, 'recent');

    assert.equal(result.files.length, 1, 'the healthy account still contributes');
    assert.equal(result.problems.length, 1);
    assert.equal(result.problems[0]!.nickname, 'onedrive@example.com');
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

  it('returns everything it fetched rather than throwing the rest away', async () => {
    /*
     * This used to cap at a hundred and discard the remainder, with nothing to
     * say the view was incomplete - so a person with more than that simply
     * never saw the rest and had no reason to think anything was missing.
     */
    (drive as unknown as Record<string, unknown>).listView = async () => ({
      files: Array.from({ length: 150 }, (_, i) => file(`f${i}.txt`, '2026-01-01T00:00:00.000Z')),
    });

    const { userId } = await seed('google_drive', 'me@example.com');
    const result = await listWorkspaceView(userId, 'recent');

    assert.equal(result.files.length, 150);
    assert.equal(result.nextCursor, undefined, 'and no more to ask for');
  });

  it('hands back a cursor while a provider still has pages', async () => {
    (drive as unknown as Record<string, unknown>).listView = async (
      _tokens: unknown,
      _view: unknown,
      pageToken?: string,
    ) => ({
      files: [file(pageToken ? 'second.txt' : 'first.txt', '2026-01-01T00:00:00.000Z')],
      nextPageToken: pageToken ? undefined : 'page-2',
    });

    const { userId } = await seed('google_drive', 'me@example.com');

    const first = await listWorkspaceView(userId, 'recent');
    assert.deepEqual(first.files.map((f) => f.name), ['first.txt']);
    assert.ok(first.nextCursor);

    const second = await listWorkspaceView(userId, 'recent', { cursor: first.nextCursor });
    assert.deepEqual(second.files.map((f) => f.name), ['second.txt']);
    assert.equal(second.nextCursor, undefined);
  });

  it('only asks the accounts that still had pages left', async () => {
    // Otherwise every "load more" re-fetches the first page of every account
    // that had already finished.
    const asked: string[] = [];
    (drive as unknown as Record<string, unknown>).listView = async (
      tokens: { accessToken?: string },
      _view: unknown,
      pageToken?: string,
    ) => {
      asked.push(tokens.accessToken ?? '?');
      return {
        files: [file('a.txt', '2026-01-01T00:00:00.000Z')],
        // Only the first account ever has a second page.
        nextPageToken: tokens.accessToken === 'token-one' && !pageToken ? 'more' : undefined,
      };
    };

    const { userId } = await seed('google_drive', 'one@example.com', 'token-one');
    await seed('google_drive', 'two@example.com', 'token-two');

    const first = await listWorkspaceView(userId, 'recent');
    asked.length = 0;

    await listWorkspaceView(userId, 'recent', { cursor: first.nextCursor });
    assert.deepEqual(asked, ['token-one']);
  });

  it('returns an empty view when nothing is connected', async () => {
    const user = await getLocalUser();
    const result = await listWorkspaceView(user.id, 'recent');

    assert.deepEqual(result, {
      files: [],
      problems: [],
      unsupported: [],
      // Nothing to ask again for, which is what an absent cursor means.
      nextCursor: undefined,
    });
  });
});
