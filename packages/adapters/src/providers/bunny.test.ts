import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AccountTokens } from '@orbit/shared-types';
import { ProviderError } from '../base.js';
import { BunnyAdapter } from './bunny.js';

const TOKENS: AccountTokens = {
  bunnyStorageZone: 'my-zone',
  bunnyAccessKey: 'zone-password',
  bunnyRegionHost: 'ny.storage.bunnycdn.com',
};

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: BodyInit | null;
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

function entry(name: string, over: Record<string, unknown> = {}) {
  return {
    ObjectName: name,
    Path: '/my-zone/',
    Length: 120,
    IsDirectory: false,
    LastChanged: '2026-08-01T10:00:00Z',
    ...over,
  };
}

const adapter = new BunnyAdapter();

beforeEach(() => {
  calls = [];
  responders = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);

    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: init?.body ?? null,
    };
    calls.push(call);

    for (const responder of responders) {
      const response = responder(call);
      if (response) return response;
    }

    return json({ error: `unmatched ${call.method} ${url.pathname}` }, { status: 500 });
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('connect', () => {
  it('proves the password before storing it', async () => {
    // A wrong password saved silently becomes a connection that fails later
    // for no visible reason.
    respondWith(() => new Response('Unauthorized', { status: 401 }));

    await assert.rejects(
      adapter.connect({
        kind: 'credentials',
        values: { bunnyStorageZone: 'my-zone', bunnyAccessKey: 'wrong' },
      }),
      ProviderError,
    );
  });

  it('defaults to the main region when none is given', async () => {
    respondWith(() => json([]));

    const tokens = await adapter.connect({
      kind: 'credentials',
      values: { bunnyStorageZone: 'my-zone', bunnyAccessKey: 'right' },
    });

    assert.equal(tokens.bunnyRegionHost, 'storage.bunnycdn.com');
  });

  it('refuses without a zone or a password', async () => {
    await assert.rejects(
      adapter.connect({ kind: 'credentials', values: { bunnyStorageZone: 'my-zone' } }),
      ProviderError,
    );
  });
});

describe('listFolder', () => {
  it('addresses the zone and the region, with the key in a header', async () => {
    respondWith(() => json([]));

    await adapter.listFolder(TOKENS, '/photos/2026');

    const call = calls[0]!;
    assert.equal(call.url.host, 'ny.storage.bunnycdn.com');
    assert.equal(call.url.pathname, '/my-zone/photos/2026/');
    assert.equal(call.headers['accesskey'], 'zone-password');
  });

  it('lists the trailing slash, which is what makes Bunny list rather than fetch', async () => {
    respondWith(() => json([]));
    await adapter.listFolder(TOKENS, '/');

    assert.ok(calls[0]!.url.pathname.endsWith('/'), calls[0]!.url.pathname);
  });

  it('maps folders and files apart', async () => {
    respondWith(() =>
      json([
        entry('holiday', { IsDirectory: true, Length: 0 }),
        entry('a.jpg', { ContentType: 'image/jpeg' }),
      ]),
    );

    const page = await adapter.listFolder(TOKENS, '/photos');

    assert.deepEqual(
      page.files.map((file) => [file.name, file.isFolder, file.virtualPath]),
      [
        ['holiday', true, '/photos/holiday'],
        ['a.jpg', false, '/photos/a.jpg'],
      ],
    );
    // The path is the id: Bunny hands out no stable identifier of its own.
    assert.equal(page.files[1]!.remoteId, '/photos/a.jpg');
  });

  it('names a file from its extension when Bunny reports no type', async () => {
    respondWith(() => json([entry('notes.pdf', { ContentType: '' })]));

    const page = await adapter.listFolder(TOKENS, '/');
    assert.equal(page.files[0]!.mimeType, 'application/pdf');
  });

  it('hides the marker Orbit writes to make an empty folder exist', async () => {
    // It is Orbit's own bookkeeping and has no business being listed back.
    respondWith(() => json([entry('.orbit-folder', { Length: 0 }), entry('a.jpg')]));

    const page = await adapter.listFolder(TOKENS, '/photos');
    assert.deepEqual(page.files.map((file) => file.name), ['a.jpg']);
  });
});

describe('listAllFiles', () => {
  it('walks the tree, because Bunny has no flat listing', async () => {
    // Why `flatEnumeration` is false: this is a request per folder, and the
    // storage breakdown and duplicate finder need it anyway.
    respondWith((call) => {
      if (call.url.pathname === '/my-zone/') {
        return json([entry('photos', { IsDirectory: true }), entry('root.txt')]);
      }
      if (call.url.pathname === '/my-zone/photos/') return json([entry('a.jpg')]);
      return json([]);
    });

    const page = await adapter.listAllFiles(TOKENS);

    assert.deepEqual(page.files.map((file) => file.virtualPath).sort(), [
      '/photos/a.jpg',
      '/root.txt',
    ]);
  });

  it('gives up rather than walking for ever', async () => {
    // Every folder contains another folder, so only the bound stops it.
    respondWith((call) => json([entry(`deeper${call.url.pathname.length}`, { IsDirectory: true })]));

    await adapter.listAllFiles(TOKENS);
    assert.ok(calls.length <= 500, `walked ${calls.length} folders`);
  });
});

describe('remove', () => {
  it('deletes each one and reports the ones that failed', async () => {
    respondWith((call) =>
      call.url.pathname.includes('locked')
        ? new Response('nope', { status: 403 })
        : new Response(null, { status: 200 }),
    );

    const result = await adapter.remove(TOKENS, ['/a.jpg', '/locked.jpg']);

    assert.deepEqual(result.succeeded, ['/a.jpg']);
    assert.equal(result.failed.length, 1);
  });

  it('asks for a folder with the trailing slash Bunny needs', async () => {
    // Without it Bunny looks for an object of that name instead of the folder.
    respondWith(() => new Response(null, { status: 200 }));

    await adapter.remove(TOKENS, ['/photos/']);
    assert.ok(calls[0]!.url.pathname.endsWith('/photos/'), calls[0]!.url.pathname);
  });
});

describe('what Bunny cannot do', () => {
  it('refuses to rename rather than downloading and re-uploading', async () => {
    /*
     * There is no server-side copy, so a rename would silently cost somebody a
     * gigabyte of transfer for what looks like a text edit.
     */
    await assert.rejects(adapter.rename(TOKENS, '/a.jpg', 'b.jpg'), ProviderError);
    assert.equal(calls.length, 0, 'and it does not start before refusing');
  });

  it('reports no quota rather than inventing one', async () => {
    // A zone is billed by what is in it; there is no allowance to be a
    // fraction of.
    assert.deepEqual(await adapter.getQuota(), { usedBytes: 0, totalBytes: 0 });
    assert.equal(adapter.capabilities.reportsQuota, false);
  });

  it('has no thumbnails, and says so rather than pretending', async () => {
    assert.equal(await adapter.getThumbnail(), null);
    assert.equal(adapter.capabilities.thumbnails, false);
  });
});

describe('upload', () => {
  it('sends the whole file in one PUT', async () => {
    // Bunny has no multipart upload, so a second chunk would overwrite the
    // first rather than continue it.
    respondWith(() => new Response(null, { status: 201 }));

    const session = await adapter.initUpload(TOKENS, '/photos', {
      name: 'a.jpg',
      sizeBytes: 2048,
      mimeType: 'image/jpeg',
    });

    assert.equal(session.chunkSize, 2048, 'one chunk, the whole file');

    const uploaded: number[] = [];
    const result = await adapter.uploadChunk(session, new Uint8Array(2048), (n) =>
      uploaded.push(n),
    );

    assert.equal(calls[0]!.method, 'PUT');
    assert.equal(calls[0]!.url.pathname, '/my-zone/photos/a.jpg');
    assert.equal(result.done, true);
    assert.equal(result.file!.virtualPath, '/photos/a.jpg');
    assert.deepEqual(uploaded, [2048]);
  });

  it('never asks for a zero-length chunk', async () => {
    // An empty file still has to be one request, not none.
    const session = await adapter.initUpload(TOKENS, '/', {
      name: 'empty.txt',
      sizeBytes: 0,
      mimeType: 'text/plain',
    });

    assert.ok(session.chunkSize >= 1);
  });
});
