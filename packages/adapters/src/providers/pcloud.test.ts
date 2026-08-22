import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AccountTokens } from '@orbit/shared-types';
import { ProviderError } from '../base.js';
import { PCloudAdapter } from './pcloud.js';

const TOKENS: AccountTokens = { accessToken: 'tok', endpoint: 'https://eapi.pcloud.com' };

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
}

let calls: Call[] = [];
let responders: Array<(call: Call) => unknown> = [];
const realFetch = globalThis.fetch;

/** Answer one call. Returning undefined passes it to the next responder. */
function respondWith(responder: (call: Call) => unknown): void {
  responders.push(responder);
}

/** pCloud answers 200 with a `result` field, so success is `result: 0`. */
function ok(body: Record<string, unknown> = {}): Response {
  return Response.json({ result: 0, ...body });
}

/** The method name of a call, which is what pCloud puts in the path. */
function methods(): string[] {
  return calls.map((call) => call.url.pathname.slice(1));
}

const adapter = new PCloudAdapter();

beforeEach(() => {
  calls = [];
  responders = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);

    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([name, value]) => [
          name.toLowerCase(),
          value,
        ]),
      ),
    };
    calls.push(call);

    for (const responder of responders) {
      const response = responder(call);
      if (response) return response as Response;
    }

    return ok();
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('connect', () => {
  it('keeps the host pCloud names, because the account only exists on one', async () => {
    // A US token sent to the EU host is an authentication failure that reads
    // like a bad password, so the region has to be remembered at sign-in.
    process.env.PCLOUD_CLIENT_ID = 'id';
    process.env.PCLOUD_CLIENT_SECRET = 'secret';

    respondWith(() => ok({ access_token: 'tok', locationid: 2, hostname: 'eapi.pcloud.com' }));

    const tokens = await adapter.connect({ kind: 'oauth', code: 'c', redirectUri: 'r' });

    assert.equal(tokens.accessToken, 'tok');
    assert.equal(tokens.endpoint, 'https://eapi.pcloud.com');
  });

  it('falls back to the region id when no hostname is given', async () => {
    process.env.PCLOUD_CLIENT_ID = 'id';
    process.env.PCLOUD_CLIENT_SECRET = 'secret';

    respondWith(() => ok({ access_token: 'tok', locationid: 2 }));

    const tokens = await adapter.connect({ kind: 'oauth', code: 'c', redirectUri: 'r' });
    assert.equal(tokens.endpoint, 'https://eapi.pcloud.com');
  });

  it('treats a result code as a failure even though the status was 200', async () => {
    process.env.PCLOUD_CLIENT_ID = 'id';
    process.env.PCLOUD_CLIENT_SECRET = 'secret';

    respondWith(() => Response.json({ result: 2000, error: 'Log in failed' }));

    await assert.rejects(
      adapter.connect({ kind: 'oauth', code: 'c', redirectUri: 'r' }),
      ProviderError,
    );
  });

  it('reads an authentication failure as 401, so the account is marked stale', async () => {
    // 1000-1999 is pCloud's authentication range. Reporting it as an ordinary
    // error would leave a dead connection looking healthy.
    respondWith(() => Response.json({ result: 1000, error: 'Log in required' }));

    await assert.rejects(adapter.getQuota(TOKENS), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.status, 401);
      return true;
    });
  });
});

describe('listFolder', () => {
  it('sends the token and asks for the folder by path', async () => {
    respondWith(() => ok({ metadata: { contents: [] } }));
    await adapter.listFolder(TOKENS, '/holiday');

    assert.equal(calls[0]!.url.origin, 'https://eapi.pcloud.com');
    assert.equal(calls[0]!.url.searchParams.get('path'), '/holiday');
    assert.equal(calls[0]!.headers['authorization'], 'Bearer tok');
  });

  it('keys files and folders on their numeric ids', async () => {
    // Paths do not survive a rename, and the trash only speaks ids.
    respondWith(() =>
      ok({
        metadata: {
          contents: [
            { name: 'holiday', isfolder: true, folderid: 12 },
            { name: 'a.jpg', isfolder: false, fileid: 34, size: 90, contenttype: 'image/jpeg' },
          ],
        },
      }),
    );

    const page = await adapter.listFolder(TOKENS, '/');

    assert.deepEqual(
      page.files.map((file) => [file.remoteId, file.name, file.isFolder, file.virtualPath]),
      [
        ['d12', 'holiday', true, '/holiday'],
        ['f34', 'a.jpg', false, '/a.jpg'],
      ],
    );
  });

  it('marks the checksum as pCloud-only, since the hash is its own construction', async () => {
    // Comparing it with an MD5 from another provider would call two different
    // files identical, so the duplicate finder has to see whose hash it is.
    respondWith(() =>
      ok({ metadata: { contents: [{ name: 'a.jpg', fileid: 34, size: 1, hash: 9876543210 }] } }),
    );

    const page = await adapter.listFolder(TOKENS, '/');
    assert.equal(page.files[0]!.checksum, 'pcloud:9876543210');
  });
});

describe('listAllFiles', () => {
  it('asks for the whole tree at once and flattens it', async () => {
    respondWith(() =>
      ok({
        metadata: {
          contents: [
            {
              name: 'holiday',
              isfolder: true,
              folderid: 12,
              contents: [{ name: 'a.jpg', fileid: 34, size: 1 }],
            },
            { name: 'b.jpg', fileid: 56, size: 2 },
          ],
        },
      }),
    );

    const page = await adapter.listAllFiles(TOKENS);

    assert.equal(calls[0]!.url.searchParams.get('recursive'), '1');
    assert.deepEqual(
      page.files.map((file) => file.virtualPath),
      ['/holiday/a.jpg', '/b.jpg'],
    );
    assert.equal(
      page.files.some((file) => file.isFolder),
      false,
      'the storage breakdown counts files, not the folders holding them',
    );
  });
});

describe('the bin', () => {
  it('lists what is in the trash', async () => {
    respondWith(() => ok({ metadata: { contents: [{ name: 'a.jpg', fileid: 34, size: 1 }] } }));

    const page = await adapter.listTrash(TOKENS);

    assert.equal(methods()[0], 'trash_list');
    assert.deepEqual(
      page.files.map((file) => file.remoteId),
      ['f34'],
    );
  });

  it('restores and purges by id', async () => {
    await adapter.restoreFromTrash(TOKENS, 'f34');
    await adapter.purgeFromTrash(TOKENS, 'd12');

    assert.deepEqual(methods(), ['trash_restore', 'trash_clear']);
    assert.equal(calls[0]!.url.searchParams.get('fileid'), '34');
    assert.equal(calls[1]!.url.searchParams.get('folderid'), '12');
  });
});

describe('remove', () => {
  it('deletes a folder recursively, so nothing is left unreachable', async () => {
    await adapter.remove(TOKENS, ['d12', 'f34']);
    assert.deepEqual(methods(), ['deletefolderrecursive', 'deletefile']);
  });

  it('reports each failure rather than abandoning the rest', async () => {
    respondWith((call) =>
      call.url.pathname === '/deletefile' && call.url.searchParams.get('fileid') === '34'
        ? Response.json({ result: 2009, error: 'File not found' })
        : ok(),
    );

    const result = await adapter.remove(TOKENS, ['f34', 'f56']);

    assert.deepEqual(result.succeeded, ['f56']);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0]!.remoteId, 'f34');
  });
});

describe('relocate', () => {
  it('moves server-side, so no bytes come through Orbit', async () => {
    respondWith(() => ok({ metadata: { name: 'a.jpg', fileid: 34, size: 1 } }));

    await adapter.relocate(TOKENS, 'f34', '/archive', { copy: false });

    assert.equal(methods()[0], 'renamefile');
    assert.equal(calls[0]!.url.searchParams.get('topath'), '/archive/');
  });

  it('refuses to copy a folder rather than pulling every file through Orbit', async () => {
    await assert.rejects(adapter.relocate(TOKENS, 'd12', '/archive', { copy: true }), ProviderError);
    assert.equal(calls.length, 0);
  });
});

describe('upload', () => {
  it('opens a handle, writes, then closes it', async () => {
    respondWith((call) =>
      call.url.pathname === '/file_open'
        ? ok({ fd: 7, fileid: 34 })
        : call.url.pathname === '/stat'
          ? ok({ metadata: { name: 'a.jpg', fileid: 34, size: 8 } })
          : ok(),
    );

    const session = await adapter.initUpload(TOKENS, '/holiday', {
      name: 'a.jpg',
      sizeBytes: 8,
      mimeType: 'image/jpeg',
    });

    const done = await adapter.uploadChunk(session, new Uint8Array(8), () => undefined);

    assert.deepEqual(methods(), ['file_open', 'file_write', 'file_close', 'stat']);
    assert.equal(done.done, true);
    assert.equal(done.file!.virtualPath, '/holiday/a.jpg');
  });

  it('writes each chunk at its own offset and closes only at the end', async () => {
    // A handle left open holds the file at a size that is not what was written.
    respondWith((call) =>
      call.url.pathname === '/file_open'
        ? ok({ fd: 7 })
        : call.url.pathname === '/stat'
          ? ok({ metadata: { name: 'big.bin', fileid: 34, size: 2 } })
          : ok(),
    );

    const session = await adapter.initUpload(TOKENS, '/', {
      name: 'big.bin',
      sizeBytes: 2,
      mimeType: 'application/octet-stream',
    });

    const first = await adapter.uploadChunk(session, new Uint8Array(1), () => undefined);
    assert.equal(first.done, false);
    assert.equal(methods().includes('file_close'), false);

    await adapter.uploadChunk(session, new Uint8Array(1), () => undefined);

    const writes = calls.filter((call) => call.url.pathname === '/file_write');
    assert.deepEqual(
      writes.map((call) => call.url.searchParams.get('offset')),
      ['0', '1'],
    );
    assert.ok(methods().includes('file_close'));
  });
});

describe('what pCloud does not have', () => {
  it('has no starring, and says so rather than failing silently', async () => {
    assert.equal(adapter.capabilities.star, false);
    await assert.rejects(adapter.star(), ProviderError);
  });

  it('returns no thumbnail for a file that cannot have one', async () => {
    // pCloud makes thumbnails for images only, and answers with an error for
    // anything else. An icon is the right outcome, not a failed page.
    respondWith(() => Response.json({ result: 2011, error: 'Thumbnail not possible' }));

    assert.equal(await adapter.getThumbnail(TOKENS, 'f34'), null);
  });

  it('keeps the token it was given, because pCloud tokens do not expire', async () => {
    assert.deepEqual(await adapter.refreshToken(TOKENS), TOKENS);
  });
});
