import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.API_RATE_LIMIT = '10000';

const { createApp } = await import('../app.js');
const { parseRange } = await import('./files.js');
const { useTestDatabase } = await import('../test-utils.js');
const { createAccount } = await import('../services/accounts.js');
const { getLocalUser } = await import('../services/users.js');
const { getAdapter } = await import('@orbit/adapters');

const drive = getAdapter('google_drive');
const pristine = {
  listFolder: drive.listFolder.bind(drive),
  getFileStream: drive.getFileStream.bind(drive),
  createFolder: drive.createFolder.bind(drive),
  rename: drive.rename.bind(drive),
  star: drive.star.bind(drive),
  remove: drive.remove.bind(drive),
  capabilities: { ...drive.capabilities },
};

function stub(name: keyof typeof pristine, fn: unknown): void {
  (drive as unknown as Record<string, unknown>)[name] = fn;
}

function restore(): void {
  for (const [name, fn] of Object.entries(pristine)) {
    if (name === 'capabilities') Object.assign(drive.capabilities, fn);
    else (drive as unknown as Record<string, unknown>)[name] = fn;
  }
}

let server: Server;
let baseUrl: string;
let accountId: string;

before(async () => {
  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  restore();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  await useTestDatabase();
  restore();

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

const json = (path: string, method: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('parseRange', () => {
  it('reads a bounded range', () => {
    assert.deepEqual(parseRange('bytes=0-99'), { start: 0, end: 99 });
    assert.deepEqual(parseRange('bytes=200-'), { start: 200, end: undefined });
  });

  it('declines what it cannot answer correctly', () => {
    // A suffix range needs a length this layer does not have, so answering it
    // would mean guessing.
    assert.equal(parseRange('bytes=-500'), null);
    assert.equal(parseRange('bytes=100-50'), null, 'end before start');
    assert.equal(parseRange('items=0-10'), null);
    assert.equal(parseRange(undefined), null);
    assert.equal(parseRange(''), null);
  });
});

describe('GET /api/files', () => {
  it('lists a folder and reports the provider capabilities', async () => {
    stub('listFolder', async () => ({
      files: [
        {
          remoteId: 'f1',
          name: 'Photos',
          virtualPath: '/Photos',
          mimeType: 'application/vnd.google-apps.folder',
          sizeBytes: 0,
          isFolder: true,
          starred: false,
          modifiedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    }));

    const res = await fetch(`${baseUrl}/api/files?accountId=${accountId}&path=/`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as {
      files: Array<{ name: string }>;
      capabilities: { star: boolean };
    };
    assert.equal(body.files[0]!.name, 'Photos');
    // The UI hides unsupported actions rather than failing them, so this has to
    // travel with the listing.
    assert.equal(typeof body.capabilities.star, 'boolean');
  });

  it('404s for an account the user does not have', async () => {
    assert.equal((await fetch(`${baseUrl}/api/files?accountId=nope`)).status, 404);
  });

  it('requires an accountId', async () => {
    assert.equal((await fetch(`${baseUrl}/api/files`)).status, 400);
  });
});

describe('GET /api/files/:id/content', () => {
  function streamOf(text: string, extra: Record<string, unknown> = {}) {
    return async () => ({
      stream: new Response(text).body!,
      contentType: 'text/plain',
      contentLength: text.length,
      ...extra,
    });
  }

  it('streams the bytes through without exposing the provider URL', async () => {
    stub('getFileStream', streamOf('hello world'));

    const res = await fetch(`${baseUrl}/api/files/f1/content?accountId=${accountId}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    assert.equal(await res.text(), 'hello world');

    // Nothing in the response may point at Google.
    assert.ok(!(res.headers.get('location') ?? '').includes('googleapis'));
  });

  it('never lets a shared cache keep a copy', async () => {
    stub('getFileStream', streamOf('secret'));
    const res = await fetch(`${baseUrl}/api/files/f1/content?accountId=${accountId}`);
    assert.match(res.headers.get('cache-control') ?? '', /private/);
    assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  });

  it('answers a range request with 206 and the range header', async () => {
    stub('getFileStream', streamOf('partial', { contentRange: 'bytes 10-16/100' }));

    const res = await fetch(`${baseUrl}/api/files/f1/content?accountId=${accountId}`, {
      headers: { range: 'bytes=10-16' },
    });

    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), 'bytes 10-16/100');
  });

  it('passes the parsed range down to the adapter', async () => {
    let seen: unknown;
    stub('getFileStream', async (_t: unknown, _id: string, range: unknown) => {
      seen = range;
      return { stream: new Response('x').body!, contentType: 'text/plain' };
    });

    await fetch(`${baseUrl}/api/files/f1/content?accountId=${accountId}`, {
      headers: { range: 'bytes=5-' },
    });

    assert.deepEqual(seen, { start: 5, end: undefined });
  });

  it('offers a filename only when a download was asked for', async () => {
    stub('getFileStream', streamOf('data'));

    const plain = await fetch(`${baseUrl}/api/files/f1/content?accountId=${accountId}`);
    assert.equal(plain.headers.get('content-disposition'), null);

    const download = await fetch(
      `${baseUrl}/api/files/f1/content?accountId=${accountId}&download=1&name=${encodeURIComponent('my report.pdf')}`,
    );
    assert.match(download.headers.get('content-disposition') ?? '', /attachment/);
    assert.match(download.headers.get('content-disposition') ?? '', /my%20report\.pdf/);
  });
});

describe('POST /api/files/folder', () => {
  it('creates a folder in the given path', async () => {
    let seen: unknown;
    stub('createFolder', async (_t: unknown, path: string, name: string) => {
      seen = { path, name };
      return {
        remoteId: 'new',
        name,
        virtualPath: `${path}/${name}`,
        mimeType: 'application/vnd.google-apps.folder',
        sizeBytes: 0,
        isFolder: true,
        starred: false,
        modifiedAt: '2026-01-01T00:00:00.000Z',
      };
    });

    const res = await json('/api/files/folder', 'POST', { accountId, path: '/Photos', name: '2026' });
    assert.equal(res.status, 201);
    assert.deepEqual(seen, { path: '/Photos', name: '2026' });
  });

  it('rejects a blank name', async () => {
    assert.equal((await json('/api/files/folder', 'POST', { accountId, name: '   ' })).status, 400);
  });
});

describe('PATCH /api/files/:id', () => {
  it('renames', async () => {
    let seen: unknown;
    stub('rename', async (_t: unknown, id: string, name: string) => {
      seen = { id, name };
    });

    const res = await json(`/api/files/f1`, 'PATCH', { accountId, name: 'renamed.txt' });
    assert.equal(res.status, 204);
    assert.deepEqual(seen, { id: 'f1', name: 'renamed.txt' });
  });

  it('stars', async () => {
    let seen: unknown;
    stub('star', async (_t: unknown, id: string, starred: boolean) => {
      seen = { id, starred };
    });

    assert.equal((await json('/api/files/f1', 'PATCH', { accountId, starred: true })).status, 204);
    assert.deepEqual(seen, { id: 'f1', starred: true });
  });

  it('refuses to star on a provider that cannot', async () => {
    drive.capabilities.star = false;
    const res = await json('/api/files/f1', 'PATCH', { accountId, starred: true });

    assert.equal(res.status, 501);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'unsupported');
  });

  it('rejects a request that changes nothing', async () => {
    assert.equal((await json('/api/files/f1', 'PATCH', { accountId })).status, 400);
  });
});

describe('DELETE /api/files', () => {
  it('deletes and reports success', async () => {
    stub('remove', async (_t: unknown, ids: string[]) => ({ succeeded: ids, failed: [] }));

    const res = await json('/api/files', 'DELETE', { accountId, remoteIds: ['a', 'b'] });
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { succeeded: string[] }).succeeded, ['a', 'b']);
  });

  it('answers 207 for a mixed batch, so a caller cannot read it as all done', async () => {
    stub('remove', async () => ({
      succeeded: ['a'],
      failed: [{ remoteId: 'b', reason: 'denied' }],
    }));

    const res = await json('/api/files', 'DELETE', { accountId, remoteIds: ['a', 'b'] });
    assert.equal(res.status, 207);

    const body = (await res.json()) as { failed: Array<{ remoteId: string }> };
    assert.equal(body.failed[0]!.remoteId, 'b');
  });

  it('requires at least one id', async () => {
    assert.equal((await json('/api/files', 'DELETE', { accountId, remoteIds: [] })).status, 400);
  });
});

describe('provider failures', () => {
  it('reports an expired grant as 409 rather than a generic error', async () => {
    stub('listFolder', async () => {
      throw new Error('needs_reauth');
    });

    const res = await fetch(`${baseUrl}/api/files?accountId=${accountId}`);
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'needs_reauth');
  });

  it('reports an unimplemented adapter method as 501', async () => {
    stub('listFolder', async () => {
      const err = new Error('not implemented');
      err.name = 'NotImplementedError';
      throw err;
    });

    assert.equal((await fetch(`${baseUrl}/api/files?accountId=${accountId}`)).status, 501);
  });
});
