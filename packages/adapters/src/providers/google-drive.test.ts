import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AccountTokens } from '@orbit/shared-types';
import { ProviderError } from '../base.js';
import { GoogleDriveAdapter, escapeQuery, toOrbitFile } from './google-drive.js';

const TOKENS: AccountTokens = { accessToken: 'test-access-token', refreshToken: 'test-refresh' };

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

beforeEach(() => {
  calls = [];
  responders = [];
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: typeof init?.body === 'string' ? init.body : init?.body?.toString(),
    };
    calls.push(call);

    for (const responder of responders) {
      const response = responder(call);
      if (response) return response;
    }
    return json({ error: { message: `unmatched ${call.method} ${url.pathname}` } }, { status: 500 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const adapter = new GoogleDriveAdapter();

describe('connect', () => {
  it('exchanges the code and keeps the refresh token', async () => {
    respondWith((call) =>
      call.url.href === 'https://oauth2.googleapis.com/token'
        ? json({ access_token: 'at', refresh_token: 'rt', expires_in: 3599 })
        : undefined,
    );

    const tokens = await adapter.connect({
      kind: 'oauth',
      code: 'auth-code',
      redirectUri: 'http://localhost:8787/auth/callback/google_drive',
    });

    assert.equal(tokens.accessToken, 'at');
    assert.equal(tokens.refreshToken, 'rt');
    assert.ok(tokens.expiresAt! > Date.now());

    const sent = new URLSearchParams(calls[0]!.body);
    assert.equal(sent.get('code'), 'auth-code');
    assert.equal(sent.get('grant_type'), 'authorization_code');
  });

  it('fails loudly when Google returns no refresh token', async () => {
    respondWith(() => json({ access_token: 'at', expires_in: 3599 }));

    await assert.rejects(
      adapter.connect({ kind: 'oauth', code: 'c', redirectUri: 'http://localhost/cb' }),
      /refresh token/i,
    );
  });

  it('refuses a credentials connection', async () => {
    await assert.rejects(adapter.connect({ kind: 'credentials', values: {} }), ProviderError);
  });
});

describe('refreshToken', () => {
  it('keeps the existing refresh token when Google does not rotate one', async () => {
    respondWith(() => json({ access_token: 'new-at', expires_in: 3599 }));

    const refreshed = await adapter.refreshToken(TOKENS);
    assert.equal(refreshed.accessToken, 'new-at');
    assert.equal(refreshed.refreshToken, 'test-refresh');
  });

  it('refuses when there is nothing to refresh with', async () => {
    await assert.rejects(adapter.refreshToken({ accessToken: 'at' }), /reconnect/i);
  });
});

describe('listFolder', () => {
  it('lists the root without any path lookups', async () => {
    respondWith((call) =>
      call.url.pathname === '/drive/v3/files'
        ? json({
            files: [
              { id: 'f1', name: 'Photos', mimeType: 'application/vnd.google-apps.folder' },
              { id: 'f2', name: 'notes.txt', mimeType: 'text/plain', size: '120', starred: true },
            ],
          })
        : undefined,
    );

    const page = await adapter.listFolder(TOKENS, '/');

    assert.equal(calls.length, 1, 'the root needs no resolution');
    assert.match(calls[0]!.url.searchParams.get('q')!, /'root' in parents/);
    assert.equal(calls[0]!.headers.authorization, 'Bearer test-access-token');

    assert.equal(page.files.length, 2);
    assert.deepEqual(
      page.files.map((f) => [f.name, f.isFolder, f.virtualPath]),
      [
        ['Photos', true, '/Photos'],
        ['notes.txt', false, '/notes.txt'],
      ],
    );
    assert.equal(page.files[1]!.sizeBytes, 120);
    assert.equal(page.files[1]!.starred, true);
  });

  it('walks a nested path one segment at a time', async () => {
    respondWith((call) => {
      const q = call.url.searchParams.get('q') ?? '';
      if (q.includes("name = 'Photos'")) return json({ files: [{ id: 'photos-id' }] });
      if (q.includes("name = '2026'")) return json({ files: [{ id: '2026-id' }] });
      return json({ files: [{ id: 'x', name: 'trip.jpg', mimeType: 'image/jpeg', size: '9' }] });
    });

    const page = await adapter.listFolder(TOKENS, '/Photos/2026');

    assert.equal(calls.length, 3, 'two lookups then the listing');
    assert.match(calls[1]!.url.searchParams.get('q')!, /'photos-id' in parents/);
    assert.match(calls[2]!.url.searchParams.get('q')!, /'2026-id' in parents/);
    assert.equal(page.files[0]!.virtualPath, '/Photos/2026/trip.jpg');
  });

  it('reports a missing folder rather than listing the wrong one', async () => {
    respondWith(() => json({ files: [] }));
    await assert.rejects(adapter.listFolder(TOKENS, '/Nope'), /No folder at/);
  });

  it('includes shared drives in the listing', async () => {
    respondWith(() => json({ files: [] }));
    await adapter.listFolder(TOKENS, '/');
    assert.equal(calls[0]!.url.searchParams.get('includeItemsFromAllDrives'), 'true');
    assert.equal(calls[0]!.url.searchParams.get('supportsAllDrives'), 'true');
  });
});

describe('getFileStream', () => {
  it('streams a normal file with alt=media', async () => {
    respondWith((call) => {
      if (call.url.searchParams.get('fields') === 'mimeType,size') {
        return json({ mimeType: 'image/png', size: '10' });
      }
      if (call.url.searchParams.get('alt') === 'media') {
        return new Response('bytes', { headers: { 'content-type': 'image/png', 'content-length': '5' } });
      }
      return undefined;
    });

    const result = await adapter.getFileStream(TOKENS, 'file-1');
    assert.equal(result.contentType, 'image/png');
    assert.equal(result.contentLength, 5);
  });

  it('exports a Google Doc instead of downloading it', async () => {
    respondWith((call) => {
      if (call.url.searchParams.get('fields') === 'mimeType,size') {
        return json({ mimeType: 'application/vnd.google-apps.document' });
      }
      if (call.url.pathname.endsWith('/export')) {
        return new Response('docx', { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } });
      }
      return undefined;
    });

    const result = await adapter.getFileStream(TOKENS, 'doc-1');
    const exportCall = calls.find((c) => c.url.pathname.endsWith('/export'));
    assert.ok(exportCall, 'a Google Doc must be exported, not fetched with alt=media');
    assert.equal(
      exportCall.url.searchParams.get('mimeType'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    assert.match(result.contentType, /wordprocessingml/);
  });

  it('passes a byte range through', async () => {
    respondWith((call) => {
      if (call.url.searchParams.get('fields') === 'mimeType,size') return json({ mimeType: 'video/mp4' });
      return new Response('partial', {
        status: 206,
        headers: { 'content-range': 'bytes 100-199/5000', 'content-type': 'video/mp4' },
      });
    });

    const result = await adapter.getFileStream(TOKENS, 'v1', { start: 100, end: 199 });
    const download = calls[1]!;
    assert.equal(download.headers.range, 'bytes=100-199');
    assert.equal(result.contentRange, 'bytes 100-199/5000');
  });
});

describe('remove', () => {
  it('trashes rather than permanently deleting', async () => {
    respondWith(() => json({}));
    await adapter.remove(TOKENS, ['a']);

    assert.equal(calls[0]!.method, 'PATCH');
    assert.deepEqual(JSON.parse(calls[0]!.body!), { trashed: true });
  });

  it('keeps going after one failure and reports both sides', async () => {
    respondWith((call) =>
      call.url.pathname.endsWith('/bad')
        ? json({ error: { message: 'nope' } }, { status: 403 })
        : json({}),
    );

    const result = await adapter.remove(TOKENS, ['good', 'bad', 'good2']);
    assert.deepEqual(result.succeeded, ['good', 'good2']);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0]!.remoteId, 'bad');
  });
});

describe('star and rename', () => {
  it('patches the starred flag', async () => {
    respondWith(() => json({}));
    await adapter.star(TOKENS, 'f', true);
    assert.deepEqual(JSON.parse(calls[0]!.body!), { starred: true });
  });

  it('patches the name', async () => {
    respondWith(() => json({}));
    await adapter.rename(TOKENS, 'f', 'renamed.txt');
    assert.deepEqual(JSON.parse(calls[0]!.body!), { name: 'renamed.txt' });
  });
});

describe('initUpload', () => {
  it('starts a resumable session and returns the upload URL', async () => {
    respondWith((call) => {
      if (call.url.pathname === '/drive/v3/files') return json({ files: [] });
      if (call.url.href.startsWith('https://www.googleapis.com/upload/')) {
        return new Response(null, { status: 200, headers: { location: 'https://upload.example/session-1' } });
      }
      return undefined;
    });

    const session = await adapter.initUpload(TOKENS, '/', {
      name: 'big.bin',
      sizeBytes: 1000,
      mimeType: 'application/octet-stream',
    });

    assert.equal(session.uploadUrl, 'https://upload.example/session-1');
    assert.equal(session.chunkSize % (256 * 1024), 0, 'Drive requires 256 KiB-aligned chunks');
  });

  it('fails when Drive returns no session URL', async () => {
    respondWith((call) =>
      call.url.href.startsWith('https://www.googleapis.com/upload/')
        ? new Response(null, { status: 200 })
        : undefined,
    );

    await assert.rejects(
      adapter.initUpload(TOKENS, '/', { name: 'x', sizeBytes: 1, mimeType: 'text/plain' }),
      /resumable upload URL/,
    );
  });
});

describe('uploadChunk', () => {
  const session = {
    provider: 'google_drive' as const,
    remoteSessionId: 'https://upload.example/s',
    uploadUrl: 'https://upload.example/s',
    chunkSize: 8,
    state: { offset: 0, totalBytes: 8, virtualPath: '/big.bin' },
  };

  it('treats 308 as "keep going", not an error', async () => {
    respondWith(() => new Response(null, { status: 308 }));

    const progress: number[] = [];
    const result = await adapter.uploadChunk({ ...session, state: { ...session.state } }, new Uint8Array(4), (n) =>
      progress.push(n),
    );

    assert.equal(result.done, false);
    assert.deepEqual(progress, [4]);
    assert.equal(calls[0]!.headers['content-range'], 'bytes 0-3/8');
  });

  it('returns the finished file on the last chunk', async () => {
    respondWith(() => json({ id: 'new-file', name: 'big.bin', mimeType: 'application/octet-stream', size: '8' }));

    const result = await adapter.uploadChunk({ ...session, state: { ...session.state } }, new Uint8Array(8), () => {});
    assert.equal(result.done, true);
    assert.equal(result.file?.remoteId, 'new-file');
    assert.equal(result.file?.virtualPath, '/big.bin');
  });
});

describe('listChangesSince', () => {
  it('establishes a cursor without reporting a delta on first run', async () => {
    respondWith((call) =>
      call.url.pathname.endsWith('/changes/startPageToken') ? json({ startPageToken: '900' }) : undefined,
    );

    const result = await adapter.listChangesSince(TOKENS, null);
    assert.equal(result.cursor, '900');
    assert.equal(result.changed.length, 0);
    assert.equal(result.deletedRemoteIds.length, 0);
  });

  it('treats a trashed file as a deletion', async () => {
    respondWith(() =>
      json({
        changes: [
          { fileId: 'a', file: { id: 'a', name: 'kept.txt', mimeType: 'text/plain' } },
          { fileId: 'b', file: { id: 'b', name: 'binned.txt', mimeType: 'text/plain', trashed: true } },
          { fileId: 'c', removed: true },
        ],
        newStartPageToken: '901',
      }),
    );

    const result = await adapter.listChangesSince(TOKENS, '900');
    assert.deepEqual(result.changed.map((f) => f.remoteId), ['a']);
    assert.deepEqual(result.deletedRemoteIds.sort(), ['b', 'c']);
    assert.equal(result.hasMore, false);
    assert.equal(result.cursor, '901');
  });
});

describe('getQuota', () => {
  it('reads usage and limit', async () => {
    respondWith(() => json({ storageQuota: { usage: '1024', limit: '4096' } }));
    assert.deepEqual(await adapter.getQuota(TOKENS), { usedBytes: 1024, totalBytes: 4096 });
  });

  it('reports zero total for a pooled Workspace account, rather than failing', async () => {
    respondWith(() => json({ storageQuota: { usage: '1024' } }));
    assert.deepEqual(await adapter.getQuota(TOKENS), { usedBytes: 1024, totalBytes: 0 });
  });
});

describe('helpers', () => {
  it('escapes quotes and backslashes in a Drive query', () => {
    assert.equal(escapeQuery("Bob's"), "Bob\\'s");
    assert.equal(escapeQuery('a\\b'), 'a\\\\b');
  });

  it('maps a Google-native document to zero bytes rather than NaN', () => {
    const file = toOrbitFile(
      { id: 'd', name: 'Doc', mimeType: 'application/vnd.google-apps.document' },
      '/Doc',
    );
    assert.equal(file.sizeBytes, 0);
    assert.equal(file.isFolder, false);
  });
});
