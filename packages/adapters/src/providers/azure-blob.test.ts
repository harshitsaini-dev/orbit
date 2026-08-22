import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AccountTokens } from '@orbit/shared-types';
import { ProviderError } from '../base.js';
import { AzureBlobAdapter } from './azure-blob.js';

const TOKENS: AccountTokens = {
  azureAccountName: 'acct',
  azureAccountKey: Buffer.from('a-test-account-key').toString('base64'),
  azureContainer: 'photos',
};

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
}

let calls: Call[] = [];
let responders: Array<(call: Call) => Response | undefined> = [];
const realFetch = globalThis.fetch;

function respondWith(responder: (call: Call) => Response | undefined): void {
  responders.push(responder);
}

/** An EnumerationResults body, in the shape Azure actually returns one. */
function listing(inner: string, marker = ''): Response {
  return new Response(
    `<?xml version="1.0" encoding="utf-8"?><EnumerationResults>${inner}<NextMarker>${marker}</NextMarker></EnumerationResults>`,
    { status: 200, headers: { 'content-type': 'application/xml' } },
  );
}

function blob(name: string, over: { size?: number; md5?: string } = {}): string {
  return (
    `<Blob><Name>${name}</Name><Properties>` +
    `<Last-Modified>Sat, 01 Aug 2026 10:00:00 GMT</Last-Modified>` +
    `<Content-Length>${over.size ?? 120}</Content-Length>` +
    (over.md5 ? `<Content-MD5>${over.md5}</Content-MD5>` : '') +
    `<Content-Type>image/jpeg</Content-Type>` +
    `</Properties></Blob>`
  );
}

/** HEAD is how the adapter re-reads a blob after writing it. */
function head(): Response {
  return new Response(null, {
    headers: { 'content-length': '10', 'last-modified': new Date(0).toUTCString() },
  });
}

const adapter = new AzureBlobAdapter();

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
    };
    calls.push(call);

    for (const responder of responders) {
      const response = responder(call);
      if (response) return response;
    }

    return new Response('<Error/>', { status: 500 });
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('connect', () => {
  it('proves the key before storing it', async () => {
    // A wrong key saved silently becomes a connection that fails later for no
    // visible reason.
    respondWith(() => new Response('<Error/>', { status: 403 }));

    await assert.rejects(
      adapter.connect({
        kind: 'credentials',
        values: { azureAccountName: 'acct', azureAccountKey: 'k', azureContainer: 'photos' },
      }),
      ProviderError,
    );
  });

  it('refuses without an account, a key and a container', async () => {
    await assert.rejects(
      adapter.connect({
        kind: 'credentials',
        values: { azureAccountName: 'acct', azureAccountKey: 'k' },
      }),
      ProviderError,
    );
  });
});

describe('listFolder', () => {
  it('asks with a delimiter, which is what makes folders exist at all', async () => {
    // Without it Azure returns every blob under the prefix, however deep.
    respondWith(() => listing(''));
    await adapter.listFolder(TOKENS, '/holiday');

    const call = calls[0]!;
    assert.equal(call.url.searchParams.get('delimiter'), '/');
    assert.equal(call.url.searchParams.get('restype'), 'container');
    assert.equal(call.url.searchParams.get('prefix'), 'holiday/');
  });

  it('signs every request and declares the API version', async () => {
    respondWith(() => listing(''));
    await adapter.listFolder(TOKENS, '/');

    assert.match(calls[0]!.headers['authorization']!, /^SharedKey acct:/);
    assert.ok(calls[0]!.headers['x-ms-version']);
    assert.ok(calls[0]!.headers['x-ms-date']);
  });

  it('turns prefixes into folders and blobs into files', async () => {
    respondWith(() =>
      listing(`<Blobs><BlobPrefix><Name>holiday/</Name></BlobPrefix>${blob('a.jpg')}</Blobs>`),
    );

    const page = await adapter.listFolder(TOKENS, '/');

    assert.deepEqual(
      page.files.map((file) => [file.name, file.isFolder, file.virtualPath]),
      [
        ['holiday', true, '/holiday'],
        ['a.jpg', false, '/a.jpg'],
      ],
    );
  });

  it('converts the MD5 to hex, so it compares with every other provider', async () => {
    // Azure reports it base64. A checksum in two encodings compares equal to
    // nothing, and the duplicate finder would call identical files different.
    const hex = 'd41d8cd98f00b204e9800998ecf8427e';
    const base64 = Buffer.from(hex, 'hex').toString('base64');

    respondWith(() => listing(`<Blobs>${blob('a.jpg', { md5: base64 })}</Blobs>`));

    const page = await adapter.listFolder(TOKENS, '/');
    assert.equal(page.files[0]!.checksum, hex);
  });

  it('hides the marker Orbit writes to make an empty folder exist', async () => {
    respondWith(() => listing(`<Blobs>${blob('holiday/.orbit-folder')}${blob('a.jpg')}</Blobs>`));

    const page = await adapter.listFolder(TOKENS, '/');
    assert.deepEqual(
      page.files.map((file) => file.name),
      ['a.jpg'],
    );
  });

  it('carries the marker through as a page token', async () => {
    respondWith(() => listing(`<Blobs>${blob('a.jpg')}</Blobs>`, 'next-page'));

    const page = await adapter.listFolder(TOKENS, '/');
    assert.equal(page.nextPageToken, 'next-page');
  });

  it('reports no page token when the listing is finished', async () => {
    // Azure sends an empty NextMarker rather than omitting it, and treating
    // that as a cursor is an endless loop.
    respondWith(() => listing(`<Blobs>${blob('a.jpg')}</Blobs>`));

    const page = await adapter.listFolder(TOKENS, '/');
    assert.equal(page.nextPageToken, undefined);
  });
});

describe('listAllFiles', () => {
  it('asks without a delimiter, so it reaches every blob', async () => {
    // This feeds the storage breakdown and the duplicate finder, which want
    // the whole container rather than one folder of it.
    respondWith(() => listing(`<Blobs>${blob('holiday/a.jpg')}</Blobs>`));

    const page = await adapter.listAllFiles(TOKENS);

    assert.equal(calls[0]!.url.searchParams.get('delimiter'), null);
    assert.deepEqual(
      page.files.map((file) => file.virtualPath),
      ['/holiday/a.jpg'],
    );
  });
});

describe('upload', () => {
  it('stages blocks and commits them', async () => {
    respondWith((call) => (call.method === 'HEAD' ? head() : new Response(null, { status: 201 })));

    const session = await adapter.initUpload(TOKENS, '/holiday', {
      name: 'a.jpg',
      sizeBytes: 8,
      mimeType: 'image/jpeg',
    });

    const done = await adapter.uploadChunk(session, new Uint8Array(8), () => undefined);

    const staged = calls.filter((call) => call.url.searchParams.get('comp') === 'block');
    const committed = calls.filter((call) => call.url.searchParams.get('comp') === 'blocklist');

    assert.equal(staged.length, 1);
    assert.equal(committed.length, 1, 'a block staged and never committed is not a file');
    assert.equal(done.done, true);
    assert.equal(done.file!.virtualPath, '/holiday/a.jpg');
  });

  it('gives every block an id of the same length, as Azure requires', async () => {
    respondWith((call) => (call.method === 'HEAD' ? head() : new Response(null, { status: 201 })));

    const session = await adapter.initUpload(TOKENS, '/', {
      name: 'big.bin',
      sizeBytes: 2,
      mimeType: 'application/octet-stream',
    });

    await adapter.uploadChunk(session, new Uint8Array(1), () => undefined);
    await adapter.uploadChunk(session, new Uint8Array(1), () => undefined);

    const ids = calls
      .filter((call) => call.url.searchParams.get('comp') === 'block')
      .map((call) => call.url.searchParams.get('blockid')!);

    assert.equal(ids.length, 2);
    assert.equal(ids[0]!.length, ids[1]!.length, 'mixed-length block ids are rejected outright');
  });
});

describe('relocate', () => {
  it('copies server-side, so no bytes come through Orbit', async () => {
    respondWith((call) => (call.method === 'HEAD' ? head() : new Response(null, { status: 202 })));

    await adapter.relocate(TOKENS, 'a.jpg', '/archive', { copy: true });

    const copy = calls.find((call) => call.headers['x-ms-copy-source']);
    assert.ok(copy, 'Copy Blob is what makes this free');
    assert.match(copy.headers['x-ms-copy-source']!, /\/photos\/a\.jpg$/);
    assert.equal(
      calls.some((call) => call.method === 'DELETE'),
      false,
      'a copy deletes nothing',
    );
  });

  it('moves by copying then deleting the source', async () => {
    respondWith((call) => (call.method === 'HEAD' ? head() : new Response(null, { status: 202 })));

    await adapter.relocate(TOKENS, 'a.jpg', '/archive', { copy: false });
    assert.ok(calls.some((call) => call.method === 'DELETE'));
  });
});

describe('what Azure does not have', () => {
  it('reports no quota rather than inventing one', async () => {
    assert.deepEqual(await adapter.getQuota(), { usedBytes: 0, totalBytes: 0 });
    assert.equal(adapter.capabilities.reportsQuota, false);
  });

  it('keeps no bin, so a delete there is final', () => {
    assert.equal(adapter.capabilities.trash, false);
    assert.equal(adapter.capabilities.purgeTrash, false);
  });

  it('has no thumbnails, and says so rather than pretending', async () => {
    assert.equal(await adapter.getThumbnail(), null);
  });
});
