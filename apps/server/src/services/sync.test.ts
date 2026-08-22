import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

const { mirrorSize, syncAccount, syncAll } = await import('./sync.js');
const { createAccount } = await import('./accounts.js');
const { getLocalUser } = await import('./users.js');
const { useTestDatabase } = await import('../test-utils.js');
const { getAdapter, ProviderError } = await import('@orbit/adapters');
const { db } = await import('../lib/db.js');
const { accounts, filesMirror, syncLog } = await import('@orbit/db');
const { eq } = await import('drizzle-orm');

const drive = getAdapter('google_drive');
const pristine = {
  listChangesSince: drive.listChangesSince.bind(drive),
  listAllFiles: drive.listAllFiles.bind(drive),
  capabilities: { ...drive.capabilities },
};

function restore(): void {
  (drive as unknown as Record<string, unknown>).listChangesSince = pristine.listChangesSince;
  (drive as unknown as Record<string, unknown>).listAllFiles = pristine.listAllFiles;
  Object.assign(drive.capabilities, pristine.capabilities);
}

beforeEach(async () => {
  await useTestDatabase();
  restore();

  // Every first pass now seeds the mirror before following the delta feed, so
  // an unstubbed enumeration would reach the network. Empty by default; tests
  // about the baseline override it.
  (drive as unknown as Record<string, unknown>).listAllFiles = async () => ({ files: [] });
});

function file(name: string, extra: Record<string, unknown> = {}) {
  return {
    remoteId: name,
    name,
    virtualPath: `/${name}`,
    mimeType: 'text/plain',
    sizeBytes: 10,
    isFolder: false,
    starred: false,
    modifiedAt: '2026-08-01T10:00:00.000Z',
    ...extra,
  };
}

async function seed(nickname = 'me@example.com') {
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

describe('syncing an account with a delta feed', () => {
  it('writes what changed into the mirror', async () => {
    (drive as unknown as Record<string, unknown>).listChangesSince = async () => ({
      changed: [file('a.txt'), file('b.txt')],
      deletedRemoteIds: [],
      cursor: 'cursor-1',
      hasMore: false,
    });

    const { userId, accountId } = await seed();
    const result = await syncAccount(userId, accountId);

    assert.equal(result.status, 'ok');
    assert.equal(result.changed, 2);
    assert.equal(await mirrorSize(accountId), 2);
  });

  it('removes what the provider says is gone', async () => {
    let pass = 0;
    (drive as unknown as Record<string, unknown>).listChangesSince = async () => {
      pass += 1;
      return pass === 1
        ? { changed: [file('a.txt'), file('b.txt')], deletedRemoteIds: [], cursor: 'c1', hasMore: false }
        : { changed: [], deletedRemoteIds: ['a.txt'], cursor: 'c2', hasMore: false };
    };

    const { userId, accountId } = await seed();
    await syncAccount(userId, accountId);
    const second = await syncAccount(userId, accountId);

    assert.equal(second.deleted, 1);
    assert.equal(await mirrorSize(accountId), 1);
  });

  it('updates a file seen again rather than duplicating it', async () => {
    let pass = 0;
    (drive as unknown as Record<string, unknown>).listChangesSince = async () => {
      pass += 1;
      return {
        changed: [file('a.txt', { sizeBytes: pass === 1 ? 10 : 999, name: 'a.txt' })],
        deletedRemoteIds: [],
        cursor: `c${pass}`,
        hasMore: false,
      };
    };

    const { userId, accountId } = await seed();
    await syncAccount(userId, accountId);
    await syncAccount(userId, accountId);

    assert.equal(await mirrorSize(accountId), 1);
    const [row] = await db().select().from(filesMirror).where(eq(filesMirror.accountId, accountId));
    assert.equal(row!.sizeBytes, 999);
  });

  it('stores the cursor every page, not only at the end', async () => {
    // A pass cut short by a restart has to resume rather than enumerate the
    // whole account again.
    let page = 0;
    (drive as unknown as Record<string, unknown>).listChangesSince = async () => {
      page += 1;
      return {
        changed: [file(`page-${page}.txt`)],
        deletedRemoteIds: [],
        cursor: `cursor-${page}`,
        hasMore: page < 3,
      };
    };

    const { userId, accountId } = await seed();
    await syncAccount(userId, accountId);

    const [row] = await db().select().from(accounts).where(eq(accounts.id, accountId));
    assert.equal(row!.deltaCursor, 'cursor-3');
    assert.ok(row!.lastSyncedAt);
  });

  it('stops at the page limit and says so, without losing its place', async () => {
    (drive as unknown as Record<string, unknown>).listChangesSince = async () => ({
      changed: [file(`${Math.random()}.txt`)],
      deletedRemoteIds: [],
      cursor: 'always-more',
      hasMore: true,
    });

    const { userId, accountId } = await seed();
    const result = await syncAccount(userId, accountId);

    assert.equal(result.status, 'ok', 'hitting the cap is not a failure');
    assert.equal(result.partial, true);
    assert.match(result.message ?? '', /next pass/);
  });
});

describe('syncing an account without a delta feed', () => {
  it('enumerates everything instead', async () => {
    Object.assign(drive.capabilities, { delta: false, flatEnumeration: true });
    (drive as unknown as Record<string, unknown>).listAllFiles = async () => ({
      files: [file('a.txt'), file('b.txt'), file('c.txt')],
    });

    const { userId, accountId } = await seed();
    const result = await syncAccount(userId, accountId);

    assert.equal(result.changed, 3);
    assert.equal(await mirrorSize(accountId), 3);
  });

  it('says nothing was mirrored when the provider cannot be enumerated', async () => {
    // An object store with neither a delta feed nor flat enumeration has no way
    // to be mirrored, which is worth recording rather than reporting as ok and
    // leaving an empty mirror to look like an empty account.
    Object.assign(drive.capabilities, { delta: false, flatEnumeration: false });

    const { userId, accountId } = await seed();
    const result = await syncAccount(userId, accountId);

    assert.equal(result.status, 'ok');
    assert.match(result.message ?? '', /no mirror/);
    assert.equal(await mirrorSize(accountId), 0);
  });
});

describe('when a provider fails', () => {
  it('records the failure instead of throwing', async () => {
    // One provider having a bad afternoon must not stop the pass for the rest.
    (drive as unknown as Record<string, unknown>).listChangesSince = async () => {
      throw new Error('the provider exploded');
    };

    const { userId, accountId } = await seed();
    const result = await syncAccount(userId, accountId);

    assert.equal(result.status, 'error');
    assert.match(result.message ?? '', /exploded/);

    const [logged] = await db().select().from(syncLog).where(eq(syncLog.accountId, accountId));
    assert.equal(logged!.status, 'error');
  });

  it('marks a dead grant so the UI can ask for a reconnect', async () => {
    // Otherwise it retries every hour forever and the user is never told.
    (drive as unknown as Record<string, unknown>).listChangesSince = async () => {
      throw new ProviderError('google_drive', 401, 'invalid_grant');
    };

    const { userId, accountId } = await seed();
    await syncAccount(userId, accountId);

    const [row] = await db().select().from(accounts).where(eq(accounts.id, accountId));
    assert.equal(row!.status, 'needs_reauth');
  });

  it('does not mark a transient failure as a dead grant', async () => {
    (drive as unknown as Record<string, unknown>).listChangesSince = async () => {
      throw new ProviderError('google_drive', 503, 'try again later');
    };

    const { userId, accountId } = await seed();
    await syncAccount(userId, accountId);

    const [row] = await db().select().from(accounts).where(eq(accounts.id, accountId));
    assert.equal(row!.status, 'ok');
  });
});

describe('syncAll', () => {
  it('covers every account and keeps going past a failure', async () => {
    let call = 0;
    (drive as unknown as Record<string, unknown>).listChangesSince = async () => {
      call += 1;
      if (call === 1) throw new Error('first one fails');
      return { changed: [file('ok.txt')], deletedRemoteIds: [], cursor: 'c', hasMore: false };
    };

    await seed('one@example.com');
    await seed('two@example.com');

    const results = await syncAll();

    assert.equal(results.length, 2);
    assert.equal(results.filter((result) => result.status === 'error').length, 1);
    assert.equal(results.filter((result) => result.status === 'ok').length, 1);
  });

  it('skips an account already known to need reconnecting', async () => {
    // It would only fail again, and the failure is already recorded against it.
    const { accountId } = await seed();
    await db().update(accounts).set({ status: 'needs_reauth' }).where(eq(accounts.id, accountId));

    assert.deepEqual(await syncAll(), []);
  });
});

describe('the first pass', () => {
  it('seeds the mirror before following the delta feed', async () => {
    // A fresh cursor means "from now on", so the first delta call reports
    // nothing. Without a baseline the mirror would only ever learn about files
    // that changed after Orbit connected - which for an untouched account is
    // never.
    const seen: string[] = [];

    (drive as unknown as Record<string, unknown>).listAllFiles = async () => {
      seen.push('enumerate');
      return { files: [file('existing-1.txt'), file('existing-2.txt')] };
    };
    (drive as unknown as Record<string, unknown>).listChangesSince = async (
      _tokens: unknown,
      cursor: string | null,
    ) => {
      seen.push(`delta ${cursor ?? 'fresh'}`);
      return cursor
        ? { changed: [file('changed.txt')], deletedRemoteIds: [], cursor: 'c2', hasMore: false }
        : { changed: [], deletedRemoteIds: [], cursor: 'c1', hasMore: false };
    };

    const { userId, accountId } = await seed();
    await syncAccount(userId, accountId);

    assert.deepEqual(seen, ['enumerate', 'delta fresh']);
    assert.equal(await mirrorSize(accountId), 2);
  });

  it('does not enumerate again once a cursor exists', async () => {
    // The whole point of a delta feed is not paying for a full walk every hour.
    let enumerations = 0;

    (drive as unknown as Record<string, unknown>).listAllFiles = async () => {
      enumerations += 1;
      return { files: [file('a.txt')] };
    };
    (drive as unknown as Record<string, unknown>).listChangesSince = async (
      _tokens: unknown,
      cursor: string | null,
    ) => ({
      changed: cursor ? [file('b.txt')] : [],
      deletedRemoteIds: [],
      cursor: 'cursor-1',
      hasMore: false,
    });

    const { userId, accountId } = await seed();
    await syncAccount(userId, accountId);
    await syncAccount(userId, accountId);

    assert.equal(enumerations, 1);
    assert.equal(await mirrorSize(accountId), 2);
  });
});
