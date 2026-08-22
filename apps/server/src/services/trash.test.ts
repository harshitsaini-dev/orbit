import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

const { listTrash, purge, restore } = await import('./trash.js');
const { createAccount } = await import('./accounts.js');
const { getLocalUser } = await import('./users.js');
const { useTestDatabase } = await import('../test-utils.js');
const { getAdapter } = await import('@orbit/adapters');

const drive = getAdapter('google_drive');
const s3 = getAdapter('s3');

const pristine = {
  listTrash: (drive as unknown as Record<string, unknown>).listTrash,
  restoreFromTrash: (drive as unknown as Record<string, unknown>).restoreFromTrash,
  purgeFromTrash: (drive as unknown as Record<string, unknown>).purgeFromTrash,
};

beforeEach(async () => {
  await useTestDatabase();
  Object.assign(drive, pristine);
});

function file(name: string, modifiedAt = '2026-08-01T10:00:00.000Z') {
  return {
    remoteId: `id-${name}`,
    name,
    virtualPath: `/${name}`,
    mimeType: 'text/plain',
    sizeBytes: 10,
    isFolder: false,
    starred: false,
    modifiedAt,
  };
}

async function seed(provider: 'google_drive' | 's3', nickname: string) {
  const user = await getLocalUser();
  const account = await createAccount({
    userId: user.id,
    provider,
    catalogueKey: provider === 's3' ? 'cloudflare_r2' : 'google_drive',
    nickname,
    remoteAccountId: nickname,
    tokens: { accessToken: 'a' },
    ...(provider === 's3'
      ? { s3Endpoint: 'https://x', s3Bucket: 'b', s3Region: 'auto' }
      : {}),
  });

  return { userId: user.id, accountId: account.id };
}

describe('what is in the bin', () => {
  it('names the drives that keep none, rather than leaving them out', async () => {
    // A delete that cannot be undone is worth saying before somebody makes
    // one, not after.
    const { userId } = await seed('google_drive', 'drive');
    await seed('s3', 'bucket');

    (drive as unknown as Record<string, unknown>).listTrash = async () => ({ files: [] });

    const result = await listTrash(userId);
    assert.deepEqual(
      result.noBin.map((entry) => entry.nickname),
      ['bucket'],
    );
    assert.equal(s3.capabilities.trash, false);
  });

  it('says whether each file can actually be destroyed early', async () => {
    // Drive lets an ordinary account empty its bin; Dropbox does not, and one
    // flag for both would offer a button that fails on most accounts.
    const { userId } = await seed('google_drive', 'drive');
    (drive as unknown as Record<string, unknown>).listTrash = async () => ({
      files: [file('a.txt')],
    });

    const result = await listTrash(userId);
    assert.equal(result.files[0]!.canPurge, true);
    assert.equal(getAdapter('dropbox').capabilities.purgeTrash, false, 'and Dropbox says no');
  });

  it('puts the most recently deleted first', async () => {
    // Somebody opening this page is almost always after something just lost.
    const { userId } = await seed('google_drive', 'drive');
    (drive as unknown as Record<string, unknown>).listTrash = async () => ({
      files: [file('old.txt', '2020-01-01T00:00:00.000Z'), file('new.txt', '2026-08-20T00:00:00.000Z')],
    });

    const result = await listTrash(userId);
    assert.deepEqual(result.files.map((f) => f.name), ['new.txt', 'old.txt']);
  });

  it('reports a drive it could not reach instead of showing an empty bin', async () => {
    const { userId } = await seed('google_drive', 'drive');
    (drive as unknown as Record<string, unknown>).listTrash = async () => {
      throw new Error('needs_reauth');
    };

    const result = await listTrash(userId);
    assert.equal(result.files.length, 0);
    assert.equal(result.problems[0]!.reason, 'needs reconnecting');
  });

  it('pages, because a deleted folder is not small', async () => {
    const { userId } = await seed('google_drive', 'drive');
    (drive as unknown as Record<string, unknown>).listTrash = async (
      _tokens: unknown,
      pageToken?: string,
    ) => ({
      files: [file(pageToken ? 'second.txt' : 'first.txt')],
      nextPageToken: pageToken ? undefined : 'page-2',
    });

    const first = await listTrash(userId);
    assert.ok(first.nextCursor);

    const second = await listTrash(userId, { cursor: first.nextCursor });
    assert.deepEqual(second.files.map((f) => f.name), ['second.txt']);
    assert.equal(second.nextCursor, undefined);
  });
});

describe('restoring and destroying', () => {
  it('restores through the provider', async () => {
    const { userId, accountId } = await seed('google_drive', 'drive');

    let restored: string | null = null;
    (drive as unknown as Record<string, unknown>).restoreFromTrash = async (
      _tokens: unknown,
      remoteId: string,
    ) => {
      restored = remoteId;
    };

    assert.deepEqual(await restore(userId, accountId, 'id-a.txt'), { ok: true });
    assert.equal(restored, 'id-a.txt');
  });

  it('refuses to restore from a drive that keeps no bin', async () => {
    const { userId, accountId } = await seed('s3', 'bucket');
    assert.deepEqual(await restore(userId, accountId, 'anything'), {
      ok: false,
      reason: 'unsupported',
    });
  });

  it('refuses to destroy where the provider will not allow it', async () => {
    // Keeping a bin and letting somebody empty it are separate promises.
    const { userId, accountId } = await seed('s3', 'bucket');
    assert.deepEqual(await purge(userId, accountId, 'anything'), {
      ok: false,
      reason: 'unsupported',
    });
  });

  it('destroys through the provider when it is allowed', async () => {
    const { userId, accountId } = await seed('google_drive', 'drive');

    let purged: string | null = null;
    (drive as unknown as Record<string, unknown>).purgeFromTrash = async (
      _tokens: unknown,
      remoteId: string,
    ) => {
      purged = remoteId;
    };

    assert.deepEqual(await purge(userId, accountId, 'id-a.txt'), { ok: true });
    assert.equal(purged, 'id-a.txt');
  });

  it('answers a drive that is not the caller\'s as missing', async () => {
    const { userId } = await seed('google_drive', 'drive');
    assert.deepEqual(await restore(userId, 'not-mine', 'anything'), {
      ok: false,
      reason: 'not_found',
    });
  });
});
