import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AccountTokens } from '@orbit/shared-types';
import { ProviderError } from '../base.js';
import { S3CompatibleAdapter } from './s3-compatible.js';

const TOKENS: AccountTokens = {
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret',
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  bucket: 'photos',
};

const PATH_STYLE: AccountTokens = { ...TOKENS, forcePathStyle: true };

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

function xml(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/xml' },
    ...init,
  });
}

/** A ListObjectsV2 response, with keys URL-encoded as encoding-type=url asks. */
function listing(options: {
  contents?: Array<{ key: string; size: number; modified?: string; etag?: string }>;
  prefixes?: string[];
  next?: string;
}): Response {
  const contents = (options.contents ?? [])
    .map(
      (item) =>
        `<Contents><Key>${encodeURIComponent(item.key).replace(/%2F/g, '/')}</Key>` +
        `<Size>${item.size}</Size>` +
        `<LastModified>${item.modified ?? '2026-08-01T10:00:00.000Z'}</LastModified>` +
        `${item.etag ? `<ETag>&quot;${item.etag}&quot;</ETag>` : ''}</Contents>`,
    )
    .join('');

  const prefixes = (options.prefixes ?? [])
    .map((prefix) => `<CommonPrefixes><Prefix>${encodeURIComponent(prefix).replace(/%2F/g, '/')}</Prefix></CommonPrefixes>`)
    .join('');

  const truncated = options.next
    ? `<IsTruncated>true</IsTruncated><NextContinuationToken>${options.next}</NextContinuationToken>`
    : '<IsTruncated>false</IsTruncated>';

  return xml(`<?xml version="1.0"?><ListBucketResult>${prefixes}${contents}${truncated}</ListBucketResult>`);
}

beforeEach(() => {
  calls = [];
  responders = [];

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
    return new Response('<Error><Code>NoSuchKey</Code><Message>not stubbed</Message></Error>', {
      status: 404,
    });
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const adapter = new S3CompatibleAdapter();

describe('S3 addressing', () => {
  it('puts the bucket in the hostname by default', async () => {
    respondWith(() => listing({}));
    await adapter.listFolder(TOKENS, '/');

    assert.equal(calls[0]!.url.host, 'photos.s3.example.com');
    assert.equal(calls[0]!.url.pathname, '/');
  });

  it('puts the bucket in the path when the store needs it there', async () => {
    // R2 and Supabase reject virtual-hosted addressing; getting this wrong
    // produces a signature error rather than anything that names the cause.
    respondWith(() => listing({}));
    await adapter.listFolder(PATH_STYLE, '/');

    assert.equal(calls[0]!.url.host, 's3.example.com');
    assert.equal(calls[0]!.url.pathname, '/photos');
  });

  it('signs every request', async () => {
    respondWith(() => listing({}));
    await adapter.listFolder(TOKENS, '/');

    assert.match(calls[0]!.headers['authorization']!, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//);
    assert.ok(calls[0]!.headers['x-amz-content-sha256']);
  });

  it('refuses to build a request from an incomplete connection', async () => {
    await assert.rejects(
      () => adapter.listFolder({ accessKeyId: 'a' }, '/'),
      (err: unknown) => err instanceof ProviderError && /endpoint or credentials/.test(err.message),
    );
  });
});

describe('listing a folder', () => {
  it('turns common prefixes into folders and keys into files', async () => {
    respondWith(() =>
      listing({
        prefixes: ['holiday/2026/'],
        contents: [{ key: 'holiday/beach.jpg', size: 2048, etag: 'abc123' }],
      }),
    );

    const page = await adapter.listFolder(TOKENS, '/holiday');

    assert.equal(page.files.length, 2);
    const folder = page.files.find((file) => file.isFolder)!;
    assert.equal(folder.name, '2026');
    assert.equal(folder.virtualPath, '/holiday/2026');
    assert.equal(folder.remoteId, 'holiday/2026/');

    const file = page.files.find((f) => !f.isFolder)!;
    assert.equal(file.name, 'beach.jpg');
    assert.equal(file.virtualPath, '/holiday/beach.jpg');
    assert.equal(file.sizeBytes, 2048);
    assert.equal(file.mimeType, 'image/jpeg');
    assert.equal(file.checksum, 'abc123');
  });

  it('asks for one level at a time', async () => {
    respondWith(() => listing({}));
    await adapter.listFolder(TOKENS, '/holiday/2026');

    const query = calls[0]!.url.searchParams;
    assert.equal(query.get('list-type'), '2');
    assert.equal(query.get('delimiter'), '/');
    assert.equal(query.get('prefix'), 'holiday/2026/');
    // Keys can hold bytes that are not valid XML text; asking for them encoded
    // is what makes them unambiguous to read back.
    assert.equal(query.get('encoding-type'), 'url');
  });

  it('uses no prefix at the root', async () => {
    respondWith(() => listing({}));
    await adapter.listFolder(TOKENS, '/');
    assert.equal(calls[0]!.url.searchParams.get('prefix'), null);
  });

  it('hides the marker object that stands for a folder', async () => {
    // Created by createFolder and by every other S3 client; showing it would
    // put an empty zero-byte file beside every folder.
    respondWith(() =>
      listing({ contents: [{ key: 'holiday/', size: 0 }, { key: 'holiday/beach.jpg', size: 10 }] }),
    );

    const page = await adapter.listFolder(TOKENS, '/');
    assert.deepEqual(page.files.map((f) => f.name), ['beach.jpg']);
  });

  it('carries the continuation token through', async () => {
    respondWith(() => listing({ contents: [{ key: 'a.txt', size: 1 }], next: 'more-please' }));
    const page = await adapter.listFolder(TOKENS, '/');
    assert.equal(page.nextPageToken, 'more-please');

    responders = [];
    respondWith(() => listing({}));
    await adapter.listFolder(TOKENS, '/', 'more-please');
    assert.equal(calls[1]!.url.searchParams.get('continuation-token'), 'more-please');
  });

  it('reports no next page when the store says it is not truncated', async () => {
    // A store can send a token alongside IsTruncated=false; following it would
    // loop over the same last page forever.
    respondWith(() =>
      xml('<ListBucketResult><IsTruncated>false</IsTruncated><NextContinuationToken>x</NextContinuationToken></ListBucketResult>'),
    );

    const page = await adapter.listFolder(TOKENS, '/');
    assert.equal(page.nextPageToken, undefined);
  });

  it('decodes keys that arrived percent-encoded', async () => {
    respondWith(() => listing({ contents: [{ key: 'my holiday/a+b & c.txt', size: 5 }] }));
    const page = await adapter.listFolder(TOKENS, '/');
    assert.equal(page.files[0]!.name, 'a+b & c.txt');
  });
});

describe('reading a file', () => {
  it('passes a range through, and reports what came back', async () => {
    respondWith((call) =>
      call.method === 'GET' && call.headers['range']
        ? new Response('partial', {
            status: 206,
            headers: {
              'content-type': 'image/jpeg',
              'content-length': '7',
              'content-range': 'bytes 0-6/100',
            },
          })
        : undefined,
    );

    const result = await adapter.getFileStream(TOKENS, 'holiday/beach.jpg', { start: 0, end: 6 });

    assert.equal(calls[0]!.headers['range'], 'bytes=0-6');
    assert.equal(result.contentRange, 'bytes 0-6/100');
    assert.equal(result.contentLength, 7);
    assert.equal(result.contentType, 'image/jpeg');
  });

  it('asks for an open-ended range when no end is given', async () => {
    respondWith(() => new Response('rest', { status: 206 }));
    await adapter.getFileStream(TOKENS, 'a.bin', { start: 100 });
    assert.equal(calls[0]!.headers['range'], 'bytes=100-');
  });

  it('reads metadata without downloading the object', async () => {
    respondWith((call) =>
      call.method === 'HEAD'
        ? new Response(null, {
            status: 200,
            headers: {
              'content-length': '4096',
              'last-modified': 'Sat, 01 Aug 2026 10:00:00 GMT',
              etag: '"deadbeef"',
            },
          })
        : undefined,
    );

    const file = await adapter.getFileMeta(TOKENS, 'holiday/beach.jpg');

    assert.equal(calls[0]!.method, 'HEAD');
    assert.equal(file.sizeBytes, 4096);
    assert.equal(file.checksum, 'deadbeef');
  });

  it('does not pass a multipart ETag off as a checksum', async () => {
    // A multipart ETag ends in "-<partcount>" and is not a hash of the content,
    // so an integrity check against it fails on every large file.
    respondWith(() => listing({ contents: [{ key: 'big.bin', size: 99, etag: 'abc-3' }] }));
    const page = await adapter.listFolder(TOKENS, '/');
    assert.equal(page.files[0]!.checksum, undefined);
  });
});

describe('folders, which do not exist', () => {
  it('creates one by writing the marker object', async () => {
    respondWith((call) => (call.method === 'PUT' ? new Response(null, { status: 200 }) : undefined));

    const folder = await adapter.createFolder(TOKENS, '/holiday', '2027');

    assert.equal(calls[0]!.method, 'PUT');
    assert.equal(calls[0]!.url.pathname, '/holiday/2027/');
    assert.equal(folder.isFolder, true);
    assert.equal(folder.virtualPath, '/holiday/2027');
  });

  it('deletes every key beneath one', async () => {
    respondWith((call) => {
      if (call.method === 'GET') {
        return listing({ contents: [{ key: 'holiday/', size: 0 }, { key: 'holiday/a.jpg', size: 1 }] });
      }
      return new Response(null, { status: 204 });
    });

    const result = await adapter.remove(TOKENS, ['holiday/']);

    assert.deepEqual(result.succeeded, ['holiday/']);
    const deleted = calls.filter((call) => call.method === 'DELETE').map((call) => call.url.pathname);
    // The marker alone would leave the contents orphaned and unreachable.
    assert.deepEqual(deleted.sort(), ['/holiday/', '/holiday/a.jpg']);
  });

  it('deletes a single object without listing anything', async () => {
    respondWith(() => new Response(null, { status: 204 }));
    await adapter.remove(TOKENS, ['a.jpg']);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, 'DELETE');
  });

  it('reports which of a batch failed rather than failing the batch', async () => {
    respondWith((call) =>
      call.url.pathname === '/bad.jpg'
        ? new Response('<Error><Code>AccessDenied</Code><Message>no</Message></Error>', { status: 403 })
        : new Response(null, { status: 204 }),
    );

    const result = await adapter.remove(TOKENS, ['good.jpg', 'bad.jpg']);

    assert.deepEqual(result.succeeded, ['good.jpg']);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0]!.remoteId, 'bad.jpg');
  });
});

describe('rename, which is a copy and a delete', () => {
  it('copies then deletes a single object', async () => {
    respondWith((call) => (call.method === 'PUT' ? xml('<CopyObjectResult/>') : new Response(null, { status: 204 })));

    await adapter.rename(TOKENS, 'holiday/beach.jpg', 'sea.jpg');

    assert.equal(calls[0]!.method, 'PUT');
    assert.equal(calls[0]!.url.pathname, '/holiday/sea.jpg');
    assert.equal(calls[0]!.headers['x-amz-copy-source'], '/photos/holiday/beach.jpg');
    assert.equal(calls[1]!.method, 'DELETE');
    assert.equal(calls[1]!.url.pathname, '/holiday/beach.jpg');
  });

  it('moves every key when renaming a folder', async () => {
    respondWith((call) => {
      if (call.method === 'GET') {
        return listing({ contents: [{ key: 'old/', size: 0 }, { key: 'old/a.jpg', size: 1 }] });
      }
      if (call.method === 'PUT') return xml('<CopyObjectResult/>');
      return new Response(null, { status: 204 });
    });

    await adapter.rename(TOKENS, 'old/', 'new');

    const copied = calls.filter((c) => c.method === 'PUT').map((c) => c.url.pathname);
    assert.deepEqual(copied.sort(), ['/new/', '/new/a.jpg']);
  });

  it('does not delete the original until every copy has succeeded', async () => {
    // Deleting as it goes would leave a folder half under each name if the
    // store refused one of the copies partway through.
    let copies = 0;
    respondWith((call) => {
      if (call.method === 'GET') {
        return listing({ contents: [{ key: 'old/a.jpg', size: 1 }, { key: 'old/b.jpg', size: 1 }] });
      }
      if (call.method === 'PUT') {
        copies += 1;
        return copies === 2
          ? new Response('<Error><Code>AccessDenied</Code><Message>no</Message></Error>', { status: 403 })
          : xml('<CopyObjectResult/>');
      }
      return new Response(null, { status: 204 });
    });

    await assert.rejects(() => adapter.rename(TOKENS, 'old/', 'new'));
    assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0);
  });

  it('treats an error inside a 200 as a failed copy', async () => {
    // S3 streams the body while the copy runs, so the status is sent before the
    // outcome is known; trusting it would silently lose the object.
    respondWith((call) =>
      call.method === 'PUT'
        ? xml('<Error><Code>InternalError</Code><Message>copy failed</Message></Error>')
        : new Response(null, { status: 204 }),
    );

    await assert.rejects(
      () => adapter.rename(TOKENS, 'a.jpg', 'b.jpg'),
      (err: unknown) => err instanceof ProviderError && /copy failed/.test(err.message),
    );
    assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0);
  });

  it('does nothing when the name has not changed', async () => {
    await adapter.rename(TOKENS, 'a.jpg', 'a.jpg');
    assert.equal(calls.length, 0);
  });
});

describe('multipart upload', () => {
  const meta = { name: 'clip.mp4', sizeBytes: 12, mimeType: 'video/mp4' };

  function stubUpload(): void {
    respondWith((call) => {
      if (call.url.searchParams.has('uploads')) {
        return xml('<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>');
      }
      if (call.method === 'PUT') {
        return new Response(null, { status: 200, headers: { etag: '"part-etag"' } });
      }
      return xml('<CompleteMultipartUploadResult><ETag>"final"</ETag></CompleteMultipartUploadResult>');
    });
  }

  it('starts a multipart upload and completes it with the parts', async () => {
    stubUpload();

    const session = await adapter.initUpload(TOKENS, '/videos', meta);
    assert.equal(session.remoteSessionId, 'upload-1');

    const progress: number[] = [];
    const result = await adapter.uploadChunk(session, new Uint8Array(12), (n) => progress.push(n));

    assert.equal(result.done, true);
    assert.equal(result.file!.virtualPath, '/videos/clip.mp4');
    assert.deepEqual(progress, [12]);

    const complete = calls.at(-1)!;
    assert.equal(complete.method, 'POST');
    assert.equal(complete.url.searchParams.get('uploadId'), 'upload-1');
    assert.match(complete.body!, /<PartNumber>1<\/PartNumber>/);
    assert.match(complete.body!, /<ETag>"part-etag"<\/ETag>/);
  });

  it('numbers parts from one and keeps going until the last', async () => {
    stubUpload();

    const session = await adapter.initUpload(TOKENS, '/videos', { ...meta, sizeBytes: 6 * 1024 * 1024 + 10 });

    const first = await adapter.uploadChunk(session, new Uint8Array(6 * 1024 * 1024), () => {});
    assert.equal(first.done, false);

    const second = await adapter.uploadChunk(session, new Uint8Array(10), () => {});
    assert.equal(second.done, true);

    const complete = calls.at(-1)!;
    assert.match(complete.body!, /<PartNumber>1<\/PartNumber>[\s\S]*<PartNumber>2<\/PartNumber>/);
  });

  it('refuses an undersized part before the store does', async () => {
    // S3 rejects it with an error that does not say which part or why.
    stubUpload();
    const session = await adapter.initUpload(TOKENS, '/videos', { ...meta, sizeBytes: 20 * 1024 * 1024 });

    await assert.rejects(
      () => adapter.uploadChunk(session, new Uint8Array(1024), () => {}),
      (err: unknown) => err instanceof ProviderError && /at least/.test(err.message),
    );
  });
});

describe('search, which the store cannot do itself', () => {
  it('narrows by prefix at the store and matches names here', async () => {
    respondWith(() =>
      listing({
        contents: [
          { key: 'holiday/beach.jpg', size: 10 },
          { key: 'holiday/mountain.png', size: 20 },
        ],
      }),
    );

    const page = await adapter.search(TOKENS, { text: 'BEACH', underPath: '/holiday' });

    assert.equal(calls[0]!.url.searchParams.get('prefix'), 'holiday/');
    // No delimiter: a search has to reach inside nested folders too.
    assert.equal(calls[0]!.url.searchParams.get('delimiter'), null);
    assert.deepEqual(page.files.map((f) => f.name), ['beach.jpg']);
  });

  it('applies the size and date filters', async () => {
    respondWith(() =>
      listing({
        contents: [
          { key: 'small.bin', size: 10, modified: '2026-01-01T00:00:00.000Z' },
          { key: 'big.bin', size: 5000, modified: '2026-08-01T00:00:00.000Z' },
        ],
      }),
    );

    const bySize = await adapter.search(TOKENS, { minSizeBytes: 100 });
    assert.deepEqual(bySize.files.map((f) => f.name), ['big.bin']);

    responders = [];
    respondWith(() =>
      listing({
        contents: [
          { key: 'small.bin', size: 10, modified: '2026-01-01T00:00:00.000Z' },
          { key: 'big.bin', size: 5000, modified: '2026-08-01T00:00:00.000Z' },
        ],
      }),
    );
    const byDate = await adapter.search(TOKENS, { modifiedAfter: '2026-06-01T00:00:00.000Z' });
    assert.deepEqual(byDate.files.map((f) => f.name), ['big.bin']);
  });

  it('matches nothing when asked for starred files', async () => {
    // Nothing in a bucket can be starred, so the honest answer is none rather
    // than all of them.
    respondWith(() => listing({ contents: [{ key: 'a.jpg', size: 1 }] }));
    const page = await adapter.search(TOKENS, { starredOnly: true });
    assert.deepEqual(page.files, []);
  });

  it('keeps paging even when a page matched nothing', async () => {
    respondWith(() => listing({ contents: [{ key: 'nope.bin', size: 1 }], next: 'page-2' }));
    const page = await adapter.search(TOKENS, { text: 'zzz' });

    assert.deepEqual(page.files, []);
    assert.equal(page.nextPageToken, 'page-2');
  });
});

describe('quota', () => {
  it('sums the bytes it can see and reports no allowance', async () => {
    let served = 0;
    respondWith(() => {
      served += 1;
      return served === 1
        ? listing({ contents: [{ key: 'a', size: 100 }], next: 'p2' })
        : listing({ contents: [{ key: 'b', size: 250 }] });
    });

    const quota = await adapter.getQuota(TOKENS);

    assert.equal(quota.usedBytes, 350);
    // A bucket has no limit to report, and inventing one would draw a usage bar
    // against a number that does not exist.
    assert.equal(quota.totalBytes, 0);
  });
});

describe('capabilities', () => {
  it('admits what an object store cannot do', async () => {
    assert.equal(adapter.capabilities.star, false);
    assert.equal(adapter.capabilities.nativeFolders, false);
    assert.equal(adapter.capabilities.delta, false);
    assert.equal(adapter.capabilities.reportsQuota, false);
    assert.equal(adapter.capabilities.fullTextSearch, false);
  });

  it('has nothing to refresh, because access keys do not expire', async () => {
    assert.deepEqual(await adapter.refreshToken(TOKENS), TOKENS);
    assert.equal(calls.length, 0);
  });

  it('rejects a connection that is missing a field before storing it', async () => {
    await assert.rejects(
      () => adapter.connect({ kind: 'credentials', values: { accessKeyId: 'a' } }),
      (err: unknown) => err instanceof ProviderError && /required/.test(err.message),
    );
  });

  it('proves the credentials work before accepting them', async () => {
    respondWith(() => listing({}));
    const tokens = await adapter.connect({
      kind: 'credentials',
      values: { accessKeyId: 'a', secretAccessKey: 'b', endpoint: 'https://s3.example.com', bucket: 'c' },
    });

    // A key that cannot list is a connection that fails on first use; failing
    // here says so while the user is still looking at the form.
    assert.equal(calls.length, 1);
    assert.equal(tokens.region, 'auto');
  });
});

describe('relocate', () => {
  it('copies server-side, leaving the original where it is', async () => {
    // The bytes never come near Orbit: S3 copies key to key itself.
    const seen: Array<{ method: string; key: string; source?: string }> = [];
    respondWith((call) => {
      seen.push({
        method: call.method,
        key: new URL(call.url).pathname,
        source: call.headers['x-amz-copy-source'],
      });
      if (call.method === 'HEAD') {
        return new Response(null, {
          headers: { 'content-length': '120', 'last-modified': new Date(0).toUTCString() },
        });
      }
      return new Response('<CopyObjectResult/>', { status: 200 });
    });

    await adapter.relocate(TOKENS, 'photos/a.jpg', '/archive', { copy: true });

    const copies = seen.filter((c) => c.source);
    assert.equal(copies.length, 1);
    assert.match(copies[0]!.key, /archive\/a\.jpg$/);
    assert.equal(seen.some((c) => c.method === 'DELETE'), false, 'a copy deletes nothing');
  });

  it('moves by copying then deleting, in that order', async () => {
    // The other order would leave a half-moved folder with the original
    // already gone if a copy failed.
    const order: string[] = [];
    respondWith((call) => {
      if (call.method === 'HEAD') {
        return new Response(null, {
          headers: { 'content-length': '120', 'last-modified': new Date(0).toUTCString() },
        });
      }
      order.push(call.headers['x-amz-copy-source'] ? 'copy' : call.method);
      return new Response('<CopyObjectResult/>', { status: 200 });
    });

    await adapter.relocate(TOKENS, 'photos/a.jpg', '/archive', { copy: false });

    assert.deepEqual(order, ['copy', 'DELETE']);
  });

  it('does nothing when the destination is where it already is', async () => {
    let requests = 0;
    respondWith(() => {
      requests += 1;
      return new Response(null, {
        headers: { 'content-length': '120', 'last-modified': new Date(0).toUTCString() },
      });
    });

    await adapter.relocate(TOKENS, 'photos/a.jpg', '/photos', { copy: false });

    // One HEAD to describe it, and no copy or delete.
    assert.equal(requests, 1);
  });
});
