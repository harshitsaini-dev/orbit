import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AccountTokens } from '@orbit/shared-types';
import { ProviderError } from '../base.js';
import { DropboxAdapter, dropboxPath, dropboxToOrbitFile } from './dropbox.js';

const TOKENS: AccountTokens = { accessToken: 'dbx-access', refreshToken: 'dbx-refresh' };

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

let calls: Call[] = [];
let responders: Array<(call: Call) => Response | undefined> = [];
const realFetch = globalThis.fetch;

function respondWith(responder: (call: Call) => Response | undefined): void {
  responders.push(responder);
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    '.tag': 'file',
    id: 'id:abc',
    name: 'beach.jpg',
    path_display: '/Photos/beach.jpg',
    size: 2048,
    server_modified: '2026-08-01T10:00:00Z',
    ...overrides,
  };
}

/** The last argument sent in the Dropbox-API-Arg header, parsed. */
function argOf(call: Call): Record<string, unknown> {
  return JSON.parse(call.headers['dropbox-api-arg'] ?? '{}') as Record<string, unknown>;
}

beforeEach(() => {
  calls = [];
  responders = [];
  process.env.DROPBOX_CLIENT_ID = 'test-client-id';
  process.env.DROPBOX_CLIENT_SECRET = 'test-client-secret';

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // `RequestInfo` is a string or a Request; String() on the latter gives
      // "[object Request]" and the URL constructor then throws.
      const url =
        input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    };
    calls.push(call);

    for (const responder of responders) {
      const response = responder(call);
      if (response) return response;
    }
    return json({ error_summary: 'not stubbed' }, { status: 409 });
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const adapter = new DropboxAdapter();

describe('dropboxPath', () => {
  it('spells the root as the empty string', () => {
    // Dropbox rejects "/" outright, which is the one place its paths differ
    // from Orbit's.
    assert.equal(dropboxPath('/'), '');
    assert.equal(dropboxPath('/Photos'), '/Photos');
    assert.equal(dropboxPath('/Photos/2026/'), '/Photos/2026');
  });
});

describe('dropboxToOrbitFile', () => {
  it('uses the path as the id, because every endpoint takes a path', () => {
    // Storing Dropbox's own id would mean a lookup before each call, since no
    // endpoint accepts one.
    const file = dropboxToOrbitFile(entry() as never);
    assert.equal(file.remoteId, '/Photos/beach.jpg');
    assert.equal(file.virtualPath, '/Photos/beach.jpg');
  });

  it('keeps the content hash, which only compares with another Dropbox file', () => {
    const file = dropboxToOrbitFile(entry({ content_hash: 'abc123' }) as never);
    assert.equal(file.checksum, 'abc123');
  });

  it('marks a folder as one, with no size', () => {
    const file = dropboxToOrbitFile(
      entry({ '.tag': 'folder', name: '2026', path_display: '/Photos/2026', size: undefined }) as never,
    );
    assert.equal(file.isFolder, true);
    assert.equal(file.sizeBytes, 0);
  });
});

describe('listing', () => {
  it('reads a folder by path, with no id lookup first', async () => {
    respondWith(() => json({ entries: [entry()], has_more: false }));
    const page = await adapter.listFolder(TOKENS, '/Photos');

    // One request, not one per path segment.
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url.pathname, /\/files\/list_folder$/);
    assert.equal(JSON.parse(calls[0]!.body!).path, '/Photos');
    assert.equal(page.files[0]!.name, 'beach.jpg');
  });

  it('continues from a cursor rather than repeating the query', async () => {
    respondWith((call) =>
      call.url.pathname.endsWith('/continue')
        ? json({ entries: [], has_more: false })
        : json({ entries: [entry()], cursor: 'cur-1', has_more: true }),
    );

    const first = await adapter.listFolder(TOKENS, '/');
    assert.equal(first.nextPageToken, 'cur-1');

    await adapter.listFolder(TOKENS, '/', 'cur-1');
    assert.match(calls[1]!.url.pathname, /\/files\/list_folder\/continue$/);
    assert.equal(JSON.parse(calls[1]!.body!).cursor, 'cur-1');
  });

  it('does not offer a next page when the provider says there is none', async () => {
    // A cursor arrives on every response; following it when has_more is false
    // loops on the last page forever.
    respondWith(() => json({ entries: [entry()], cursor: 'cur-1', has_more: false }));
    const page = await adapter.listFolder(TOKENS, '/');
    assert.equal(page.nextPageToken, undefined);
  });

  it('leaves folders out of a flat enumeration', async () => {
    respondWith(() =>
      json({
        entries: [entry(), entry({ '.tag': 'folder', name: '2026', path_display: '/Photos/2026' })],
        has_more: false,
      }),
    );

    const page = await adapter.listAllFiles(TOKENS);
    assert.deepEqual(page.files.map((file) => file.name), ['beach.jpg']);
  });
});

describe('views', () => {
  it('refuses the views Dropbox has no API for', async () => {
    for (const view of ['recent', 'starred'] as const) {
      await assert.rejects(
        () => adapter.listView(TOKENS, view),
        (err: unknown) => err instanceof ProviderError && err.status === 501,
      );
    }
  });

  it('lists shared files', async () => {
    respondWith(() => json({ entries: [entry()], has_more: false }));
    await adapter.listView(TOKENS, 'shared');
    assert.match(calls[0]!.url.pathname, /\/sharing\/list_received_files$/);
  });
});

describe('search', () => {
  it('unwraps the doubly nested match shape', async () => {
    // search_v2 wraps each hit in metadata.metadata, unlike every other listing.
    respondWith(() => json({ matches: [{ metadata: { metadata: entry() } }], has_more: false }));
    const page = await adapter.search(TOKENS, { text: 'beach' });

    assert.deepEqual(page.files.map((file) => file.name), ['beach.jpg']);
  });

  it('asks for names only, which is what a free account can do', async () => {
    respondWith(() => json({ matches: [], has_more: false }));
    await adapter.search(TOKENS, { text: 'beach' });

    const body = JSON.parse(calls[0]!.body!) as { options: { filename_only: boolean } };
    assert.equal(body.options.filename_only, true);
  });

  it('scopes to a folder when given one', async () => {
    respondWith(() => json({ matches: [], has_more: false }));
    await adapter.search(TOKENS, { text: 'x', underPath: '/Photos' });

    assert.equal(JSON.parse(calls[0]!.body!).options.path, '/Photos');
  });

  it('applies the filters Dropbox does not', async () => {
    respondWith(() =>
      json({
        matches: [
          { metadata: { metadata: entry({ name: 'small.jpg', size: 10 }) } },
          { metadata: { metadata: entry({ name: 'big.jpg', size: 5000 }) } },
        ],
        has_more: false,
      }),
    );

    const page = await adapter.search(TOKENS, { minSizeBytes: 100 });
    assert.deepEqual(page.files.map((file) => file.name), ['big.jpg']);
  });
});

describe('reading a file', () => {
  it('sends the path in a header, because the body carries the file', async () => {
    respondWith(() => new Response('bytes', { status: 200, headers: { 'content-length': '5' } }));
    await adapter.getFileStream(TOKENS, '/Photos/beach.jpg');

    assert.equal(argOf(calls[0]!).path, '/Photos/beach.jpg');
  });

  it('passes a range through', async () => {
    respondWith(() =>
      new Response('part', { status: 206, headers: { 'content-range': 'bytes 0-3/100' } }),
    );

    const result = await adapter.getFileStream(TOKENS, '/a.bin', { start: 0, end: 3 });
    assert.equal(calls[0]!.headers['range'], 'bytes=0-3');
    assert.equal(result.contentRange, 'bytes 0-3/100');
  });

  it('treats a missing thumbnail as absent rather than as a failure', async () => {
    // Most file types have none, and 409 is how Dropbox says so.
    respondWith(() => json({ error_summary: 'unsupported_extension' }, { status: 409 }));
    assert.equal(await adapter.getThumbnail(TOKENS, '/a.txt'), null);
  });
});

describe('writing', () => {
  it('renames by moving, since the path is the identity', async () => {
    respondWith(() => json({ metadata: entry() }));
    await adapter.rename(TOKENS, '/Photos/beach.jpg', 'sea.jpg');

    const body = JSON.parse(calls[0]!.body!) as { from_path: string; to_path: string };
    assert.match(calls[0]!.url.pathname, /\/files\/move_v2$/);
    assert.equal(body.from_path, '/Photos/beach.jpg');
    assert.equal(body.to_path, '/Photos/sea.jpg');
  });

  it('reports which of a batch failed rather than failing the batch', async () => {
    respondWith((call) =>
      call.body?.includes('/bad.jpg')
        ? json({ error_summary: 'path/not_found' }, { status: 409 })
        : json({ metadata: entry() }),
    );

    const result = await adapter.remove(TOKENS, ['/good.jpg', '/bad.jpg']);
    assert.deepEqual(result.succeeded, ['/good.jpg']);
    assert.equal(result.failed.length, 1);
  });
});

describe('upload', () => {
  it('appends every chunk but the last, then finishes with it', async () => {
    respondWith((call) => {
      if (call.url.pathname.endsWith('/upload_session/start')) return json({ session_id: 'sess-1' });
      if (call.url.pathname.endsWith('/append_v2')) return new Response(null, { status: 200 });
      return json(entry({ name: 'clip.mp4', path_display: '/Videos/clip.mp4' }));
    });

    const session = await adapter.initUpload(TOKENS, '/Videos', {
      name: 'clip.mp4',
      sizeBytes: 20,
      mimeType: 'video/mp4',
    });

    const first = await adapter.uploadChunk(session, new Uint8Array(10), () => {});
    assert.equal(first.done, false);

    const second = await adapter.uploadChunk(session, new Uint8Array(10), () => {});
    assert.equal(second.done, true);
    assert.equal(second.file!.virtualPath, '/Videos/clip.mp4');

    const finish = calls.at(-1)!;
    assert.match(finish.url.pathname, /\/upload_session\/finish$/);
    // The offset has to be where the previous chunk ended, or Dropbox rejects
    // the whole session.
    assert.equal((argOf(finish).cursor as { offset: number }).offset, 10);
  });
});

describe('quota', () => {
  it('reads an individual allowance', async () => {
    respondWith(() => json({ used: 500, allocation: { allocated: 1000 } }));
    assert.deepEqual(await adapter.getQuota(TOKENS), { usedBytes: 500, totalBytes: 1000 });
  });

  it('reads a team member\'s allowance, which is nested deeper', async () => {
    respondWith(() => json({ used: 500, allocation: { individual: { allocated: 2000 } } }));
    assert.deepEqual(await adapter.getQuota(TOKENS), { usedBytes: 500, totalBytes: 2000 });
  });
});

describe('delta', () => {
  it('separates changed entries from deleted ones', async () => {
    respondWith(() =>
      json({
        entries: [entry(), { '.tag': 'deleted', name: 'old.jpg', path_display: '/old.jpg' }],
        cursor: 'cur-2',
        has_more: true,
      }),
    );

    const result = await adapter.listChangesSince(TOKENS, null);

    assert.deepEqual(result.changed.map((file) => file.name), ['beach.jpg']);
    assert.deepEqual(result.deletedRemoteIds, ['/old.jpg']);
    assert.equal(result.cursor, 'cur-2');
    assert.equal(result.hasMore, true);
  });
});

describe('tokens', () => {
  it('keeps the refresh token, which a refresh never returns', async () => {
    respondWith(() => json({ access_token: 'new-access', expires_in: 14400 }));
    const refreshed = await adapter.refreshToken(TOKENS);

    assert.equal(refreshed.accessToken, 'new-access');
    assert.equal(refreshed.refreshToken, 'dbx-refresh');
  });

  it('assumes a short life when no expiry is given', async () => {
    // Treating a token with no stated expiry as eternal means discovering it
    // has died only when a request fails.
    respondWith(() => json({ access_token: 'new-access' }));
    const refreshed = await adapter.refreshToken(TOKENS);

    assert.ok(refreshed.expiresAt! <= Date.now() + 14_400_000);
    assert.ok(refreshed.expiresAt! > Date.now());
  });
});
