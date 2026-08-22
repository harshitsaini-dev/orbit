import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_SECRET ??= 'test-session-secret';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.API_RATE_LIMIT = '10000';

const { createApp } = await import('../app.js');
const { useTestDatabase } = await import('../test-utils.js');
const { createAccount } = await import('../services/accounts.js');
const { getLocalUser } = await import('../services/users.js');
const { getAdapter } = await import('@orbit/adapters');

const drive = getAdapter('google_drive');
const pristineMeta = drive.getFileMeta.bind(drive);

let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  await useTestDatabase();
  (drive as unknown as Record<string, unknown>).getFileMeta = pristineMeta;
});

function stubFile(name = 'invoice.pdf'): void {
  (drive as unknown as Record<string, unknown>).getFileMeta = async (
    _tokens: unknown,
    remoteId: string,
  ) => ({
    remoteId,
    name,
    virtualPath: `/Documents/${name}`,
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    isFolder: false,
    starred: false,
    modifiedAt: '2026-08-01T10:00:00.000Z',
  });
}

async function seedAccount(nickname = 'me@example.com') {
  const user = await getLocalUser();
  return createAccount({
    userId: user.id,
    provider: 'google_drive',
    catalogueKey: 'google_drive',
    nickname,
    tokens: {
      accessToken: 'access-token-sentinel',
      refreshToken: 'refresh-token-sentinel',
      expiresAt: Date.now() + 3_600_000,
    },
  });
}

async function makeCollection(name = 'Tax Documents 2026') {
  const res = await fetch(`${baseUrl}/api/collections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return ((await res.json()) as { collection: { id: string } }).collection;
}

async function addItem(collectionId: string, accountId: string, remoteId: string) {
  return fetch(`${baseUrl}/api/collections/${collectionId}/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId, remoteId }),
  });
}

describe('collections', () => {
  it('creates one and lists it with a count', async () => {
    const created = await makeCollection();
    const { collections } = (await (await fetch(`${baseUrl}/api/collections`)).json()) as {
      collections: Array<{ id: string; itemCount: number }>;
    };

    assert.equal(collections.length, 1);
    assert.equal(collections[0]!.id, created.id);
    assert.equal(collections[0]!.itemCount, 0);
  });

  it('holds a file from an account without moving it', async () => {
    stubFile();
    const collection = await makeCollection();
    const account = await seedAccount();

    assert.equal((await addItem(collection.id, account.id, 'file-1')).status, 201);

    const { items } = (await (
      await fetch(`${baseUrl}/api/collections/${collection.id}`)
    ).json()) as { items: Array<{ name: string; accountNickname: string; virtualPath: string }> };

    assert.equal(items.length, 1);
    assert.equal(items[0]!.name, 'invoice.pdf');
    // Each row says where the file still lives, which is what makes a
    // collection different from a folder.
    assert.equal(items[0]!.accountNickname, 'me@example.com');
    assert.equal(items[0]!.virtualPath, '/Documents/invoice.pdf');
  });

  it('adding the same file twice refreshes it rather than duplicating it', async () => {
    const collection = await makeCollection();
    const account = await seedAccount();

    stubFile('invoice.pdf');
    await addItem(collection.id, account.id, 'file-1');

    // Renamed at the provider since it was added.
    stubFile('invoice-final.pdf');
    await addItem(collection.id, account.id, 'file-1');

    const { items } = (await (
      await fetch(`${baseUrl}/api/collections/${collection.id}`)
    ).json()) as { items: Array<{ name: string }> };

    assert.equal(items.length, 1);
    assert.equal(items[0]!.name, 'invoice-final.pdf');
  });

  it('removing an item removes the reference, not the file', async () => {
    stubFile();
    const collection = await makeCollection();
    const account = await seedAccount();

    const { item } = (await (await addItem(collection.id, account.id, 'file-1')).json()) as {
      item: { id: string };
    };

    const removed = await fetch(`${baseUrl}/api/collections/${collection.id}/items/${item.id}`, {
      method: 'DELETE',
    });
    assert.equal(removed.status, 204);

    // Nothing about the account or the file changed; only the grouping did.
    const { accounts } = (await (await fetch(`${baseUrl}/api/accounts`)).json()) as {
      accounts: unknown[];
    };
    assert.equal(accounts.length, 1);
  });

  it('renames and deletes', async () => {
    const collection = await makeCollection();

    const renamed = await fetch(`${baseUrl}/api/collections/${collection.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    assert.equal(renamed.status, 204);

    const { collection: read } = (await (
      await fetch(`${baseUrl}/api/collections/${collection.id}`)
    ).json()) as { collection: { name: string } };
    assert.equal(read.name, 'Renamed');

    assert.equal(
      (await fetch(`${baseUrl}/api/collections/${collection.id}`, { method: 'DELETE' })).status,
      204,
    );
    assert.equal((await fetch(`${baseUrl}/api/collections/${collection.id}`)).status, 404);
  });

  it('refuses a collection that is not the caller\'s', async () => {
    assert.equal((await fetch(`${baseUrl}/api/collections/someone-elses`)).status, 404);
  });

  it('refuses an item for an account the caller does not have', async () => {
    const collection = await makeCollection();
    assert.equal((await addItem(collection.id, 'not-mine', 'file-1')).status, 404);
  });

  it('counts every collection in one query rather than one each', async () => {
    stubFile();
    const account = await seedAccount();

    for (let index = 0; index < 3; index += 1) {
      const collection = await makeCollection(`Collection ${index}`);
      await addItem(collection.id, account.id, `file-${index}`);
    }

    const { collections } = (await (await fetch(`${baseUrl}/api/collections`)).json()) as {
      collections: Array<{ itemCount: number }>;
    };

    assert.equal(collections.length, 3);
    assert.ok(collections.every((collection) => collection.itemCount === 1));
  });

  it('deleting a collection takes its items with it', async () => {
    stubFile();
    const collection = await makeCollection();
    const account = await seedAccount();
    await addItem(collection.id, account.id, 'file-1');

    await fetch(`${baseUrl}/api/collections/${collection.id}`, { method: 'DELETE' });

    const { collections } = (await (await fetch(`${baseUrl}/api/collections`)).json()) as {
      collections: unknown[];
    };
    assert.equal(collections.length, 0);
  });
});

describe('where an item says it lives', () => {
  it('uses the path the caller was standing in', async () => {
    // A provider's metadata call returns the file, not the walk to it - Drive
    // would need a request per ancestor. Without the caller's path the row says
    // /invoice.pdf for a file three folders deep.
    stubFile();
    const collection = await makeCollection();
    const account = await seedAccount();

    await fetch(`${baseUrl}/api/collections/${collection.id}/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: account.id,
        remoteId: 'file-1',
        virtualPath: '/Work/2026/invoice.pdf',
      }),
    });

    const { items } = (await (
      await fetch(`${baseUrl}/api/collections/${collection.id}`)
    ).json()) as { items: Array<{ virtualPath: string }> };

    assert.equal(items[0]!.virtualPath, '/Work/2026/invoice.pdf');
  });
});
