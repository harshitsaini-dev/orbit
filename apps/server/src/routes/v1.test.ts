import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_SECRET ??= 'test-session-secret';
process.env.API_RATE_LIMIT = '10000';
process.env.V1_RATE_LIMIT = '10000';

const { createApp } = await import('../app.js');
const { useTestDatabase } = await import('../test-utils.js');
const { createAccount } = await import('../services/accounts.js');
const { getLocalUser } = await import('../services/users.js');
const { createToken, revokeToken } = await import('../services/api-tokens.js');
const { getAdapter } = await import('@orbit/adapters');
const { TOKEN_PREFIX } = await import('@orbit/shared-types');

const drive = getAdapter('google_drive');
const pristine = {
  listFolder: drive.listFolder.bind(drive),
  getFileMeta: drive.getFileMeta.bind(drive),
  remove: drive.remove.bind(drive),
};

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
  Object.assign(drive as unknown as Record<string, unknown>, pristine);
});

function stubDrive(): void {
  (drive as unknown as Record<string, unknown>)['listFolder'] = async () => ({
    files: [
      {
        remoteId: 'file-1',
        name: 'beach.jpg',
        virtualPath: '/Photos/beach.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 2048,
        isFolder: false,
        starred: false,
        modifiedAt: '2026-08-01T10:00:00.000Z',
      },
    ],
    nextPageToken: 'page-2',
  });

  (drive as unknown as Record<string, unknown>)['remove'] = async () => ({
    succeeded: ['file-1'],
    failed: [],
  });
}

async function seedAccount() {
  const user = await getLocalUser();
  return createAccount({
    userId: user.id,
    provider: 'google_drive',
    catalogueKey: 'google_drive',
    nickname: 'me@example.com',
    tokens: { accessToken: 'a', refreshToken: 'b', expiresAt: Date.now() + 3_600_000 },
  });
}

/** A token with exactly the scopes a case is about. */
async function tokenWith(...scopes: Parameters<typeof createToken>[0]['scopes']) {
  const user = await getLocalUser();
  const { token } = await createToken({ userId: user.id, name: 'test', scopes });
  return token;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('authenticating against /v1', () => {
  it('refuses a request with no credential', async () => {
    /*
     * Local mode gives every /api request an implicit user, and /v1 must not
     * inherit that: a public API that authenticates itself is not one.
     */
    const res = await fetch(`${baseUrl}/v1/accounts`);
    assert.equal(res.status, 401);
  });

  it('accepts a personal access token', async () => {
    await seedAccount();
    const token = await tokenWith('accounts:read');

    const res = await fetch(`${baseUrl}/v1/accounts`, { headers: bearer(token) });
    const body = (await res.json()) as { accounts: unknown[] };

    assert.equal(res.status, 200);
    assert.equal(body.accounts.length, 1);
  });

  it('issues tokens with a prefix a secret scanner can find', async () => {
    const token = await tokenWith('files:read');
    assert.ok(token.startsWith(TOKEN_PREFIX));
    // Enough entropy that guessing is not a strategy.
    assert.ok(token.length > 40);
  });

  it('refuses a revoked token', async () => {
    const user = await getLocalUser();
    const { token, record } = await createToken({
      userId: user.id,
      name: 'test',
      scopes: ['accounts:read'],
    });

    await revokeToken(user.id, record.id);

    const res = await fetch(`${baseUrl}/v1/accounts`, { headers: bearer(token) });
    assert.equal(res.status, 401);
  });

  it('refuses an expired token', async () => {
    const user = await getLocalUser();
    const { token } = await createToken({
      userId: user.id,
      name: 'test',
      scopes: ['accounts:read'],
      expiresAt: new Date(Date.now() - 1000),
    });

    assert.equal((await fetch(`${baseUrl}/v1/accounts`, { headers: bearer(token) })).status, 401);
  });

  it('answers the same for expired, revoked and invented', async () => {
    // Telling them apart tells somebody guessing which guesses were closer.
    const res = await fetch(`${baseUrl}/v1/accounts`, {
      headers: bearer(`${TOKEN_PREFIX}completely-made-up`),
    });
    const body = (await res.json()) as { error: { code: string } };

    assert.equal(res.status, 401);
    assert.equal(body.error.code, 'invalid_token');
  });

  it('rejects an Authorization header that is not a bearer', async () => {
    const res = await fetch(`${baseUrl}/v1/accounts`, {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });

    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'invalid_authorization');
  });
});

describe('scopes', () => {
  it('refuses an endpoint the token was not granted', async () => {
    const token = await tokenWith('files:read');

    const res = await fetch(`${baseUrl}/v1/accounts`, { headers: bearer(token) });
    const body = (await res.json()) as { error: { code: string; message: string } };

    // 403, not 401: the credential is real and retrying changes nothing.
    assert.equal(res.status, 403);
    assert.equal(body.error.code, 'insufficient_scope');
    assert.match(body.error.message, /accounts:read/);
  });

  it('separates reading a file from downloading it', async () => {
    // The point of having both: a token can be allowed to see that a file
    // exists without being allowed to pull its contents out of the drive.
    stubDrive();
    const account = await seedAccount();
    const token = await tokenWith('files:read');

    const list = await fetch(`${baseUrl}/v1/files?accountId=${account.id}`, {
      headers: bearer(token),
    });
    const download = await fetch(
      `${baseUrl}/v1/files/file-1/content?accountId=${account.id}`,
      { headers: bearer(token) },
    );

    assert.equal(list.status, 200);
    assert.equal(download.status, 403);
  });

  it('refuses to delete with a write token', async () => {
    stubDrive();
    const account = await seedAccount();
    const token = await tokenWith('files:write');

    const res = await fetch(`${baseUrl}/v1/files`, {
      method: 'DELETE',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, remoteIds: ['file-1'] }),
    });

    assert.equal(res.status, 403);
  });

  it('lets a delete token delete', async () => {
    stubDrive();
    const account = await seedAccount();
    const token = await tokenWith('files:delete');

    const res = await fetch(`${baseUrl}/v1/files`, {
      method: 'DELETE',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, remoteIds: ['file-1'] }),
    });

    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()) as unknown, { succeeded: ['file-1'], failed: [] });
  });

  it('tells a program what it may do without making it guess', async () => {
    const token = await tokenWith('files:read', 'shares:write');

    const res = await fetch(`${baseUrl}/v1/me`, { headers: bearer(token) });
    const body = (await res.json()) as { scopes: string[] };

    assert.deepEqual(body.scopes, ['files:read', 'shares:write']);
  });
});

describe('listing', () => {
  it('pages by cursor rather than by offset', async () => {
    // The drive changes under a reader, so page 3 of a shifted list is not
    // page 3 of anything.
    stubDrive();
    const account = await seedAccount();
    const token = await tokenWith('files:read');

    const res = await fetch(`${baseUrl}/v1/files?accountId=${account.id}`, {
      headers: bearer(token),
    });
    const body = (await res.json()) as { nextCursor: string | null; files: unknown[] };

    assert.equal(body.nextCursor, 'page-2');
    assert.equal(body.files.length, 1);
  });

  it('reports no cursor as null rather than omitting it', async () => {
    (drive as unknown as Record<string, unknown>)['listFolder'] = async () => ({ files: [] });
    const account = await seedAccount();
    const token = await tokenWith('files:read');

    const body = (await (
      await fetch(`${baseUrl}/v1/files?accountId=${account.id}`, { headers: bearer(token) })
    ).json()) as { nextCursor: string | null };

    assert.equal(body.nextCursor, null);
  });

  it('404s an account that is not the caller\'s', async () => {
    const token = await tokenWith('files:read');

    const res = await fetch(`${baseUrl}/v1/files?accountId=someone-elses`, {
      headers: bearer(token),
    });

    assert.equal(res.status, 404);
  });
});

describe('errors', () => {
  it('answers an unknown endpoint in the same shape as everything else', async () => {
    const token = await tokenWith('files:read');

    const res = await fetch(`${baseUrl}/v1/nothing-here`, { headers: bearer(token) });
    const body = (await res.json()) as { error: { code: string; requestId?: string } };

    assert.equal(res.status, 404);
    assert.equal(body.error.code, 'not_found');
    assert.ok(body.error.requestId, 'an error a user reports has to be findable in the log');
  });
});

describe('managing tokens', () => {
  it('shows the value exactly once', async () => {
    const created = await fetch(`${baseUrl}/api/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'backup script', scopes: ['files:read'] }),
    });

    const body = (await created.json()) as { token: string; record: { id: string; tail: string } };
    assert.equal(created.status, 201);
    assert.ok(body.token.startsWith(TOKEN_PREFIX));

    // And never again, from anywhere.
    const listed = await (await fetch(`${baseUrl}/api/tokens`)).text();
    assert.equal(listed.includes(body.token), false, 'the value must not be recoverable');
    assert.match(listed, new RegExp(body.record.tail));
  });

  it('stores a fingerprint, not the token', async () => {
    const token = await tokenWith('files:read');
    const { db } = await import('../lib/db.js');
    const { apiTokens } = await import('@orbit/db');

    const [row] = await db().select().from(apiTokens);

    assert.ok(row);
    assert.equal(row.tokenHash.includes(token), false);
    assert.equal(token.includes(row.tokenHash), false);
  });

  it('refuses a scope Orbit does not issue', async () => {
    // Filtering it out silently would hand back a token that grants less than
    // was asked for, and fail later somewhere unrelated.
    const res = await fetch(`${baseUrl}/api/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', scopes: ['files:read', 'files:everything'] }),
    });

    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'unknown_scope');
  });

  it('will not mint a token from a token', async () => {
    /*
     * The rule that keeps scopes meaningful. Otherwise a leaked read-only
     * token could issue itself a delete-everything one.
     */
    const token = await tokenWith('accounts:read');

    const res = await fetch(`${baseUrl}/v1/tokens`, {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'escalated', scopes: ['files:delete'] }),
    });

    assert.equal(res.status, 404, 'there is no such endpoint on the public API');
  });

  it('revokes, and the token stops working immediately', async () => {
    const created = await fetch(`${baseUrl}/api/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'temp', scopes: ['accounts:read'] }),
    });
    const { token, record } = (await created.json()) as { token: string; record: { id: string } };

    assert.equal(
      (await fetch(`${baseUrl}/v1/accounts`, { headers: bearer(token) })).status,
      200,
    );

    const revoked = await fetch(`${baseUrl}/api/tokens/${record.id}`, { method: 'DELETE' });
    assert.equal(revoked.status, 204);

    assert.equal(
      (await fetch(`${baseUrl}/v1/accounts`, { headers: bearer(token) })).status,
      401,
    );
  });
});
