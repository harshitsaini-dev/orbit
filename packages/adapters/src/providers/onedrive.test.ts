import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AccountTokens } from '@orbit/shared-types';
import { ProviderError } from '../base.js';
import { escapeGraphQuery, graphAddressOf, graphPathOf, OneDriveAdapter } from './onedrive.js';

const TOKENS: AccountTokens = { accessToken: 'graph-access', refreshToken: 'graph-refresh' };

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

/** One item as Graph returns it. */
function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'item-1',
    name: 'beach.jpg',
    size: 2048,
    lastModifiedDateTime: '2026-08-01T10:00:00Z',
    file: { mimeType: 'image/jpeg' },
    parentReference: { path: '/drive/root:/Photos' },
    ...overrides,
  };
}

beforeEach(() => {
  calls = [];
  responders = [];
  process.env.ONEDRIVE_CLIENT_ID = 'test-client-id';
  process.env.ONEDRIVE_CLIENT_SECRET = 'test-client-secret';

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
    return json({ error: { message: 'not stubbed' } }, { status: 404 });
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const adapter = new OneDriveAdapter();

describe('graphAddressOf', () => {
  it('addresses the root by id and everything else by path', () => {
    // The trailing colon is not decoration: `root:/Photos:` is a path address
    // and `root/Photos` is not, and the wrong one returns a 400 that says
    // nothing about which was meant.
    assert.equal(graphAddressOf('/'), 'root');
    assert.equal(graphAddressOf('/Photos'), 'root:/Photos:');
    assert.equal(graphAddressOf('/Photos/2026'), 'root:/Photos/2026:');
  });

  it('encodes each segment without encoding the separators', () => {
    assert.equal(graphAddressOf('/My Photos/a+b'), 'root:/My%20Photos/a%2Bb:');
  });
});

describe('graphPathOf', () => {
  it('builds a virtual path from the parent reference', () => {
    assert.equal(graphPathOf(item() as never), '/Photos/beach.jpg');
  });

  it('handles an item in the root', () => {
    assert.equal(
      graphPathOf(item({ parentReference: { path: '/drive/root:' } }) as never),
      '/beach.jpg',
    );
  });

  it('decodes a parent path that arrived encoded', () => {
    assert.equal(
      graphPathOf(item({ parentReference: { path: '/drive/root:/My%20Photos' } }) as never),
      '/My Photos/beach.jpg',
    );
  });
});

describe('escapeGraphQuery', () => {
  it('doubles a quote rather than letting it end the term', () => {
    assert.equal(escapeGraphQuery("it's"), "it''s");
  });
});

describe('listing', () => {
  it('asks for one folder at a time, by path', async () => {
    respondWith(() => json({ value: [item()] }));
    const page = await adapter.listFolder(TOKENS, '/Photos');

    assert.match(calls[0]!.url.pathname, /\/me\/drive\/root:\/Photos:\/children$/);
    assert.equal(calls[0]!.headers['authorization'], 'Bearer graph-access');
    assert.equal(page.files[0]!.virtualPath, '/Photos/beach.jpg');
    assert.equal(page.files[0]!.sizeBytes, 2048);
  });

  it('marks folders as folders', async () => {
    respondWith(() => json({ value: [item({ name: '2026', file: undefined, folder: { childCount: 3 } })] }));
    const page = await adapter.listFolder(TOKENS, '/Photos');

    assert.equal(page.files[0]!.isFolder, true);
    assert.equal(page.files[0]!.sizeBytes, 2048);
  });

  it('follows the next link as an opaque URL', async () => {
    // Graph's paging token is a whole URL with its own parameters; rebuilding
    // it from parts loses the ones it carries.
    const next = 'https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=abc';
    respondWith((call) => (call.url.searchParams.has('$skiptoken') ? json({ value: [] }) : json({ value: [item()], '@odata.nextLink': next })));

    const first = await adapter.listFolder(TOKENS, '/');
    assert.equal(first.nextPageToken, next);

    await adapter.listFolder(TOKENS, '/', next);
    assert.equal(calls[1]!.url.searchParams.get('$skiptoken'), 'abc');
  });
});

describe('views', () => {
  it('refuses starred rather than pretending to have it', async () => {
    // The capability says false; this is the matching refusal for anything that
    // asks anyway.
    await assert.rejects(
      () => adapter.listView(TOKENS, 'starred'),
      (err: unknown) => err instanceof ProviderError && err.status === 501,
    );
  });

  it('uses the right endpoint for recent and shared', async () => {
    respondWith(() => json({ value: [] }));

    await adapter.listView(TOKENS, 'recent');
    assert.match(calls[0]!.url.pathname, /\/me\/drive\/recent$/);

    await adapter.listView(TOKENS, 'shared');
    assert.match(calls[1]!.url.pathname, /\/me\/drive\/sharedWithMe$/);
  });
});

describe('search', () => {
  it('scopes to a folder when asked, and to the drive otherwise', async () => {
    respondWith(() => json({ value: [] }));

    await adapter.search(TOKENS, { text: 'beach' });
    assert.match(decodeURIComponent(calls[0]!.url.pathname), /\/me\/drive\/root\/search\(q='beach'\)/);

    await adapter.search(TOKENS, { text: 'beach', underPath: '/Photos' });
    assert.match(
      decodeURIComponent(calls[1]!.url.pathname),
      /\/me\/drive\/root:\/Photos:\/search\(q='beach'\)/,
    );
  });

  it('applies the filters Graph does not', async () => {
    respondWith(() =>
      json({
        value: [
          item({ id: 'small', name: 'small.jpg', size: 10 }),
          item({ id: 'big', name: 'big.jpg', size: 5000 }),
        ],
      }),
    );

    const page = await adapter.search(TOKENS, { minSizeBytes: 100 });
    assert.deepEqual(page.files.map((file) => file.name), ['big.jpg']);
  });

  it('matches nothing when asked for starred files', async () => {
    respondWith(() => json({ value: [item()] }));
    const page = await adapter.search(TOKENS, { starredOnly: true });
    assert.deepEqual(page.files, []);
  });
});

describe('writing', () => {
  it('renames rather than failing when a new folder name is taken', async () => {
    respondWith((call) => (call.method === 'POST' ? json(item({ name: '2027', folder: {} })) : undefined));
    await adapter.createFolder(TOKENS, '/Photos', '2027');

    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    assert.equal(body['@microsoft.graph.conflictBehavior'], 'rename');
  });

  it('reports which of a batch failed rather than failing the batch', async () => {
    respondWith((call) =>
      call.url.pathname.endsWith('/bad')
        ? json({ error: { message: 'nope' } }, { status: 403 })
        : new Response(null, { status: 204 }),
    );

    const result = await adapter.remove(TOKENS, ['good', 'bad']);
    assert.deepEqual(result.succeeded, ['good']);
    assert.equal(result.failed.length, 1);
  });
});

describe('upload', () => {
  it('sends each chunk as a content range and finishes on the final one', async () => {
    respondWith((call) => {
      if (call.url.pathname.endsWith('/createUploadSession')) {
        return json({ uploadUrl: 'https://upload.example.com/session-1' });
      }
      if (call.url.host === 'upload.example.com') {
        const range = call.headers['content-range'] ?? '';
        // 202 means "stored, keep going"; the last chunk returns the item.
        return range.startsWith('bytes 0-')
          ? new Response(null, { status: 202 })
          : json(item({ name: 'clip.mp4' }));
      }
      return undefined;
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
  });

  it('does not send the account token to the upload URL', async () => {
    // The session URL is pre-authorised; attaching the token would hand one to
    // a host that has no need of it.
    respondWith((call) => {
      if (call.url.pathname.endsWith('/createUploadSession')) {
        return json({ uploadUrl: 'https://upload.example.com/session-1' });
      }
      return json(item());
    });

    const session = await adapter.initUpload(TOKENS, '/', {
      name: 'a.bin',
      sizeBytes: 4,
      mimeType: 'application/octet-stream',
    });
    await adapter.uploadChunk(session, new Uint8Array(4), () => {});

    const upload = calls.find((call) => call.url.host === 'upload.example.com')!;
    assert.equal(upload.headers['authorization'], undefined);
  });
});

describe('delta', () => {
  it('separates changed items from deleted ones', async () => {
    respondWith(() =>
      json({
        value: [item({ id: 'kept' }), { id: 'gone', name: 'old.jpg', deleted: { state: 'deleted' } }],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/drive/root/delta?token=next',
      }),
    );

    const result = await adapter.listChangesSince(TOKENS, null);

    assert.deepEqual(result.changed.map((file) => file.remoteId), ['kept']);
    assert.deepEqual(result.deletedRemoteIds, ['gone']);
    assert.equal(result.hasMore, false);
    assert.match(result.cursor ?? '', /token=next/);
  });

  it('says there is more while a next link is present', async () => {
    respondWith(() =>
      json({ value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-page' }),
    );

    const result = await adapter.listChangesSince(TOKENS, null);
    assert.equal(result.hasMore, true);
  });
});

describe('quota and identity', () => {
  it('reads used and total from the drive', async () => {
    respondWith(() => json({ quota: { used: 500, total: 1000 } }));
    assert.deepEqual(await adapter.getQuota(TOKENS), { usedBytes: 500, totalBytes: 1000 });
  });

  it('falls back to the principal name when there is no mail address', async () => {
    // Personal Microsoft accounts usually have no `mail`, and the principal
    // name is the address the person actually knows.
    respondWith(() => json({ userPrincipalName: 'someone@outlook.com', displayName: 'Someone' }));
    const identity = await adapter.getAccountIdentity(TOKENS);

    assert.equal(identity.email, 'someone@outlook.com');
    assert.equal(identity.displayName, 'Someone');
  });
});

describe('tokens', () => {
  it('keeps the old refresh token when the exchange returns none', async () => {
    // Microsoft rotates refresh tokens but not on every exchange; discarding
    // the old one on a response without a new one disconnects the account.
    respondWith(() => json({ access_token: 'new-access', expires_in: 3600 }));
    const refreshed = await adapter.refreshToken(TOKENS);

    assert.equal(refreshed.accessToken, 'new-access');
    assert.equal(refreshed.refreshToken, 'graph-refresh');
  });

  it('takes the new refresh token when one is issued', async () => {
    respondWith(() =>
      json({ access_token: 'new-access', refresh_token: 'rotated', expires_in: 3600 }),
    );

    assert.equal((await adapter.refreshToken(TOKENS)).refreshToken, 'rotated');
  });

  it('refuses to refresh a connection that has no refresh token', async () => {
    await assert.rejects(
      () => adapter.refreshToken({ accessToken: 'only-access' }),
      (err: unknown) => err instanceof ProviderError && /refresh token/.test(err.message),
    );
  });
});
