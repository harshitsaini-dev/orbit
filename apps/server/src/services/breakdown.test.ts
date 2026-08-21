import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

const { computeBreakdown, getBreakdown, clearBreakdownCache, forgetBreakdown } = await import('./breakdown.js');
const { createAccount } = await import('./accounts.js');
const { getLocalUser } = await import('./users.js');
const { useTestDatabase } = await import('../test-utils.js');
const { getAdapter } = await import('@orbit/adapters');

const drive = getAdapter('google_drive');
const original = {
  listAllFiles: drive.listAllFiles.bind(drive),
  capabilities: { ...drive.capabilities },
};

interface Page {
  files: Array<{ name: string; mimeType: string; sizeBytes: number; isFolder?: boolean }>;
  nextPageToken?: string;
}

/** Replaces the adapter's enumeration with a fixed set of pages. */
function stubPages(pages: Page[]): { calls: number } {
  const counter = { calls: 0 };

  (drive as unknown as { listAllFiles: unknown }).listAllFiles = async (
    _tokens: unknown,
    pageToken?: string,
  ) => {
    const index = pageToken ? Number(pageToken) : 0;
    counter.calls += 1;
    const page = pages[index]!;
    return {
      files: page.files.map((file, i) => ({
        remoteId: `${index}-${i}`,
        name: file.name,
        virtualPath: `/${file.name}`,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        isFolder: file.isFolder ?? false,
        starred: false,
        modifiedAt: '2026-01-01T00:00:00.000Z',
      })),
      nextPageToken: page.nextPageToken,
    };
  };

  return counter;
}

function restore(): void {
  (drive as unknown as { listAllFiles: unknown }).listAllFiles = original.listAllFiles;
  Object.assign(drive.capabilities, original.capabilities);
}

async function seedAccount(): Promise<string> {
  const user = await getLocalUser();
  const account = await createAccount({
    userId: user.id,
    provider: 'google_drive',
    catalogueKey: 'google_drive',
    nickname: 'me@example.com',
    tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000 },
  });
  return account.id;
}

beforeEach(async () => {
  await useTestDatabase();
  clearBreakdownCache();
  restore();
});

describe('computeBreakdown', () => {
  it('totals a single page by category', async () => {
    stubPages([
      {
        files: [
          { name: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 100 },
          { name: 'b.mp4', mimeType: 'video/mp4', sizeBytes: 900 },
          { name: 'c.pdf', mimeType: 'application/pdf', sizeBytes: 50 },
        ],
      },
    ]);

    const user = await getLocalUser();
    const accountId = await seedAccount();
    const result = await computeBreakdown(user.id, accountId);

    assert.ok(result);
    assert.equal(result.fileCount, 3);
    assert.equal(result.sizeBytes, 1050);
    assert.equal(result.partial, false);
    assert.deepEqual(
      result.totals.map((t) => t.category),
      ['video', 'image', 'document'],
      'largest first',
    );
  });

  it('folds every page together rather than reporting only the last', async () => {
    stubPages([
      { files: [{ name: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 100 }], nextPageToken: '1' },
      { files: [{ name: 'b.jpg', mimeType: 'image/jpeg', sizeBytes: 200 }], nextPageToken: '2' },
      { files: [{ name: 'c.jpg', mimeType: 'image/jpeg', sizeBytes: 300 }] },
    ]);

    const user = await getLocalUser();
    const result = await computeBreakdown(user.id, await seedAccount());

    assert.ok(result);
    assert.equal(result.fileCount, 3);
    assert.equal(result.sizeBytes, 600);
    assert.equal(result.totals.length, 1);
    assert.equal(result.totals[0]!.fileCount, 3);
  });

  it('stops at the page limit and says the result is partial', async () => {
    // An account with a million files must not tie up the one backend instance.
    const pages: Page[] = Array.from({ length: 10 }, (_, i) => ({
      files: [{ name: `f${i}.jpg`, mimeType: 'image/jpeg', sizeBytes: 10 }],
      nextPageToken: String(i + 1),
    }));

    const counter = stubPages(pages);
    const user = await getLocalUser();
    const result = await computeBreakdown(user.id, await seedAccount(), { maxPages: 3 });

    assert.ok(result);
    assert.equal(result.partial, true, 'a capped scan must not present itself as complete');
    assert.equal(counter.calls, 3);
    assert.equal(result.fileCount, 3);
  });

  it('is not partial when the last page arrives inside the limit', async () => {
    stubPages([{ files: [{ name: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 1 }] }]);
    const user = await getLocalUser();
    const result = await computeBreakdown(user.id, await seedAccount(), { maxPages: 3 });

    assert.equal(result!.partial, false);
  });

  it('excludes folders from the totals', async () => {
    stubPages([
      {
        files: [
          { name: 'Photos', mimeType: 'application/vnd.google-apps.folder', sizeBytes: 0, isFolder: true },
          { name: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 10 },
        ],
      },
    ]);

    const user = await getLocalUser();
    const result = await computeBreakdown(user.id, await seedAccount());
    assert.equal(result!.fileCount, 1);
  });

  it('refuses when the provider cannot enumerate flat', async () => {
    drive.capabilities.flatEnumeration = false;
    const user = await getLocalUser();
    const accountId = await seedAccount();

    await assert.rejects(computeBreakdown(user.id, accountId), /breakdown_unsupported/);
  });

  it('returns null for an account that is not there', async () => {
    const user = await getLocalUser();
    assert.equal(await computeBreakdown(user.id, 'nope'), null);
  });

  it('stops early when aborted', async () => {
    const controller = new AbortController();
    const counter = stubPages([
      { files: [{ name: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 1 }], nextPageToken: '1' },
      { files: [{ name: 'b.jpg', mimeType: 'image/jpeg', sizeBytes: 1 }], nextPageToken: '2' },
    ]);
    controller.abort();

    const user = await getLocalUser();
    const result = await computeBreakdown(user.id, await seedAccount(), { signal: controller.signal });

    assert.equal(counter.calls, 0);
    assert.equal(result!.partial, true);
  });
});

describe('getBreakdown caching', () => {
  it('reuses a completed scan instead of walking the account again', async () => {
    const counter = stubPages([{ files: [{ name: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 1 }] }]);
    const user = await getLocalUser();
    const accountId = await seedAccount();

    await getBreakdown(user.id, accountId);
    await getBreakdown(user.id, accountId);

    assert.equal(counter.calls, 1, 'the second call must come from the cache');
  });

  it('rescans when forced', async () => {
    const counter = stubPages([{ files: [{ name: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 1 }] }]);
    const user = await getLocalUser();
    const accountId = await seedAccount();

    await getBreakdown(user.id, accountId);
    await getBreakdown(user.id, accountId, { force: true });

    assert.equal(counter.calls, 2);
  });

  it('forgets an account, so a disconnect cannot leak into a later connection', async () => {
    const counter = stubPages([{ files: [{ name: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 1 }] }]);
    const user = await getLocalUser();
    const accountId = await seedAccount();

    await getBreakdown(user.id, accountId);
    forgetBreakdown(user.id, accountId);
    await getBreakdown(user.id, accountId);

    assert.equal(counter.calls, 2);
  });
});
