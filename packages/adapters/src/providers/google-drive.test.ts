import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AccountTokens } from '@orbit/shared-types';
import { ProviderError } from '../base.js';
import {
  GOOGLE_DRIVE_FOLDER_MIME,
  GOOGLE_DRIVE_SHORTCUT_MIME,
  GoogleDriveAdapter,
  escapeQuery,
  toOrbitFile,
  withFields,
} from './google-drive.js';

/** A metadata read, as opposed to the download that follows it. */
const isMetaCall = (call: Call) =>
  !call.url.searchParams.get('alt') && (call.url.searchParams.get('fields') ?? '').includes('mimeType');

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
      // Narrowed rather than blanket-stringified: a URLSearchParams body is
      // the OAuth token exchange and its toString() is exactly what was sent,
      // while a stream or a Blob would only produce "[object …]".
      body:
        typeof init?.body === 'string'
          ? init.body
          : init?.body instanceof URLSearchParams
            ? init.body.toString()
            : undefined,
    };
    calls.push(call);

    for (const responder of responders) {
      const response = responder(call);
      if (response) return response;
    }
    return json({ error: { message: `unmatched ${call.method} ${url.pathname}` } }, { status: 500 });
  });
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
    respondWith((call) => {
      if (call.url.pathname.endsWith('/drives')) return json({ drives: [] });
      return call.url.pathname === '/drive/v3/files'
        ? json({
            files: [
              { id: 'f1', name: 'Photos', mimeType: 'application/vnd.google-apps.folder' },
              { id: 'f2', name: 'notes.txt', mimeType: 'text/plain', size: '120', starred: true },
            ],
          })
        : undefined;
    });

    const page = await adapter.listFolder(TOKENS, '/');

    // One listing and one ask for shared drives - and no walk, because the root
    // is the one path that needs no resolving.
    const lookups = calls.filter((c) => (c.url.searchParams.get('q') ?? '').includes('name ='));
    assert.deepEqual(lookups, [], 'the root needs no resolution');
    assert.equal(calls.length, 2);

    const listing = calls.find((c) => c.url.searchParams.get('q'))!;
    assert.match(listing.url.searchParams.get('q')!, /'root' in parents/);
    assert.equal(listing.headers.authorization, 'Bearer test-access-token');

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
      if (isMetaCall(call)) return json({ mimeType: 'image/png', size: '10' });
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
      if (isMetaCall(call) && !call.url.pathname.endsWith('/export')) {
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
      if (isMetaCall(call)) return json({ mimeType: 'video/mp4' });
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
    assert.deepEqual(await adapter.getQuota(TOKENS), {
      usedBytes: 1024,
      usedInDriveBytes: 0,
      trashedBytes: 0,
      totalBytes: 4096,
    });
  });

  it('separates what is in Drive from what the allowance covers', async () => {
    /*
     * Google's `usage` is the whole account - Drive, Gmail and Photos.
     *
     * It is the right figure for "how full is this account" and the wrong one
     * for "how big are the files Orbit can see". Reporting both is what lets
     * the gap be explained rather than looking like a miscount.
     */
    respondWith(() =>
      json({
        storageQuota: {
          usage: '4000',
          usageInDrive: '3000',
          usageInDriveTrash: '500',
          limit: '16000',
        },
      }),
    );

    const quota = await adapter.getQuota(TOKENS);
    assert.equal(quota.usedBytes, 4000);
    assert.equal(quota.usedInDriveBytes, 3000);
    assert.equal(quota.trashedBytes, 500, 'deleted but not purged still fills the allowance');
  });

  it('reports zero total for a pooled Workspace account, rather than failing', async () => {
    respondWith(() => json({ storageQuota: { usage: '1024' } }));
    assert.deepEqual(await adapter.getQuota(TOKENS), {
      usedBytes: 1024,
      usedInDriveBytes: 0,
      trashedBytes: 0,
      totalBytes: 0,
    });
  });
});

describe('helpers', () => {
  it('adds fields without repeating any already present', () => {
    assert.equal(withFields('mimeType,size', 'mimeType', 'shortcutDetails'), 'mimeType,size,shortcutDetails');
    assert.equal(withFields('size', 'mimeType'), 'size,mimeType');
  });

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

describe('shortcuts', () => {
  const FOLDER = 'application/vnd.google-apps.folder';

  it('presents a shortcut to a folder as a folder', () => {
    // Real Drive accounts are full of these. Without resolution they show up as
    // unopenable zero-byte files.
    const file = toOrbitFile(
      {
        id: 'sc-1',
        name: 'BCA notes',
        mimeType: GOOGLE_DRIVE_SHORTCUT_MIME,
        shortcutDetails: { targetId: 'folder-9', targetMimeType: FOLDER },
      },
      '/BCA notes',
    );

    assert.equal(file.isFolder, true);
    assert.equal(file.mimeType, FOLDER);
    assert.equal(file.shortcutTargetId, 'folder-9');
    // The id stays the shortcut's own, so rename and delete act on the pointer.
    assert.equal(file.remoteId, 'sc-1');
  });

  it('presents a shortcut to a file with the target type', () => {
    const file = toOrbitFile(
      {
        id: 'sc-2',
        name: 'photo.jpg',
        mimeType: GOOGLE_DRIVE_SHORTCUT_MIME,
        shortcutDetails: { targetId: 'img-3', targetMimeType: 'image/jpeg' },
      },
      '/photo.jpg',
    );

    assert.equal(file.isFolder, false);
    assert.equal(file.mimeType, 'image/jpeg');
    assert.equal(file.shortcutTargetId, 'img-3');
  });

  it('leaves an ordinary file untouched', () => {
    const file = toOrbitFile({ id: 'f', name: 'a.txt', mimeType: 'text/plain', size: '4' }, '/a.txt');
    assert.equal(file.shortcutTargetId, undefined);
    assert.equal(file.mimeType, 'text/plain');
  });

  it('walks a path through a shortcut into its target folder', async () => {
    respondWith((call) => {
      const q = call.url.searchParams.get('q') ?? '';
      if (q.includes("name = 'BCA notes'")) {
        return json({
          files: [{ id: 'sc-1', mimeType: GOOGLE_DRIVE_SHORTCUT_MIME, shortcutDetails: { targetId: 'folder-9' } }],
        });
      }
      return json({ files: [] });
    });

    await adapter.listFolder(TOKENS, '/BCA notes');

    // The listing must query the target folder, not the shortcut.
    assert.match(calls[1]!.url.searchParams.get('q')!, /'folder-9' in parents/);
  });

  it('accepts a shortcut when resolving a path segment', async () => {
    respondWith(() => json({ files: [] }));
    await adapter.listFolder(TOKENS, '/Somewhere').catch(() => undefined);

    const q = calls[0]!.url.searchParams.get('q')!;
    assert.match(q, /vnd\.google-apps\.shortcut/);
    assert.match(q, /shortcutDetails\.targetMimeType/);
  });

  it('streams the target of a shortcut, not the shortcut', async () => {
    respondWith((call) => {
      if (call.url.pathname.endsWith('/sc-9') ) {
        return json({ id: 'sc-9', mimeType: GOOGLE_DRIVE_SHORTCUT_MIME, shortcutDetails: { targetId: 'real-1' } });
      }
      if (call.url.pathname.endsWith('/real-1') && !call.url.searchParams.get('alt')) {
        return json({ id: 'real-1', mimeType: 'image/png', size: '12' });
      }
      if (call.url.searchParams.get('alt') === 'media') {
        return new Response('bytes', { headers: { 'content-type': 'image/png' } });
      }
      return undefined;
    });

    const result = await adapter.getFileStream(TOKENS, 'sc-9');

    const download = calls.find((c) => c.url.searchParams.get('alt') === 'media');
    assert.ok(download, 'the target must actually be downloaded');
    assert.match(download.url.pathname, /real-1$/, 'downloaded the shortcut instead of its target');
    assert.equal(result.contentType, 'image/png');
  });
});

describe('listView', () => {
  it('asks for starred files, ordered by name', async () => {
    respondWith(() => json({ files: [{ id: 's', name: 'a.txt', mimeType: 'text/plain', starred: true }] }));

    const page = await adapter.listView(TOKENS, 'starred');

    const q = calls[0]!.url.searchParams.get('q')!;
    assert.match(q, /starred = true/);
    assert.match(q, /trashed = false/);
    assert.equal(calls[0]!.url.searchParams.get('orderBy'), 'name_natural');
    assert.equal(page.files[0]!.starred, true);
  });

  it('asks for shared files, newest share first', async () => {
    respondWith(() => json({ files: [] }));
    await adapter.listView(TOKENS, 'shared');

    assert.match(calls[0]!.url.searchParams.get('q')!, /sharedWithMe = true/);
    assert.equal(calls[0]!.url.searchParams.get('orderBy'), 'sharedWithMeTime desc');
  });

  it('asks for recent files newest first, and leaves folders out', async () => {
    respondWith(() => json({ files: [] }));
    await adapter.listView(TOKENS, 'recent');

    const q = calls[0]!.url.searchParams.get('q')!;
    // A folder's timestamp changes whenever anything inside it does, so
    // including folders would make "recent" mostly folders.
    assert.match(q, /mimeType != .application\/vnd\.google-apps\.folder./);
    assert.equal(calls[0]!.url.searchParams.get('orderBy'), 'modifiedTime desc');
  });

  it('includes shared drives in every view', async () => {
    respondWith(() => json({ files: [] }));
    await adapter.listView(TOKENS, 'recent');

    assert.equal(calls[0]!.url.searchParams.get('includeItemsFromAllDrives'), 'true');
  });

  it('resolves a shortcut in a view the same way a listing does', async () => {
    respondWith(() =>
      json({
        files: [
          {
            id: 'sc',
            name: 'Notes',
            mimeType: GOOGLE_DRIVE_SHORTCUT_MIME,
            shortcutDetails: { targetId: 'folder-1', targetMimeType: 'application/vnd.google-apps.folder' },
          },
        ],
      }),
    );

    const page = await adapter.listView(TOKENS, 'starred');
    assert.equal(page.files[0]!.isFolder, true);
    assert.equal(page.files[0]!.shortcutTargetId, 'folder-1');
  });
});

const drive = new GoogleDriveAdapter();

describe('what a flat enumeration asks for', () => {
  it('asks for the checksum, which is what proves two files are the same', async () => {
    // Left out, every duplicate in the account is downgraded from certain to a
    // guess about size and name - and a guess is not something to delete on.
    respondWith(() => json({ files: [] }));
    await drive.listAllFiles(TOKENS);

    assert.match(calls[0]!.url.searchParams.get('fields') ?? '', /md5Checksum/);
  });

  it('still asks for less than a full listing does', async () => {
    // A hundred thousand files makes every extra field expensive.
    respondWith(() => json({ files: [] }));
    await drive.listAllFiles(TOKENS);

    const fields = calls[0]!.url.searchParams.get('fields') ?? '';
    assert.doesNotMatch(fields, /parents/);
    assert.doesNotMatch(fields, /trashed/);
  });
});

describe('shared drives', () => {
  it('puts them behind one folder rather than among My Drive', async () => {
    // A team drive is not in My Drive. Listing one among somebody's personal
    // folders is wrong about who owns it, wrong about who else can see it, and
    // wrong about whose quota it counts against.
    respondWith((call) => {
      if (call.url.pathname.endsWith('/drives')) {
        return json({ drives: [{ id: 'drive-marketing', name: 'Marketing' }] });
      }
      return json({ files: [{ id: 'f1', name: 'notes.txt', mimeType: 'text/plain' }] });
    });

    const page = await adapter.listFolder(TOKENS, '/');

    assert.deepEqual(
      page.files.map((f) => [f.name, f.isFolder]),
      [
        ['Shared drives', true],
        ['notes.txt', false],
      ],
    );
  });

  it('offers no such folder when there are none', async () => {
    // An empty container is worse than no container: it says there is
    // something here to look at.
    respondWith((call) => {
      if (call.url.pathname.endsWith('/drives')) return json({ drives: [] });
      return json({ files: [{ id: 'f1', name: 'notes.txt', mimeType: 'text/plain' }] });
    });

    const page = await adapter.listFolder(TOKENS, '/');
    assert.deepEqual(page.files.map((f) => f.name), ['notes.txt']);
  });

  it('lists the drives themselves inside it', async () => {
    respondWith((call) => {
      if (call.url.pathname.endsWith('/drives')) {
        return json({ drives: [{ id: 'drive-marketing', name: 'Marketing' }] });
      }
      return json({ files: [] });
    });

    const page = await adapter.listFolder(TOKENS, '/Shared drives');

    assert.deepEqual(
      page.files.map((f) => [f.name, f.isFolder]),
      [['Marketing', true]],
    );
    // A shared drive's id doubles as its root folder id, so everything below
    // behaves like any other folder from here.
    assert.equal(page.files[0]!.remoteId, 'drive-marketing');
    /*
     * Resolving the path costs one lookup and listing it costs none.
     *
     * The lookup is deliberate: Drive is asked whether a real folder of that
     * name exists first, so somebody who genuinely has one called "Shared
     * drives" still reaches theirs. The synthetic folder is the fallback, not
     * the override.
     */
    const lookups = calls.filter((c) => (c.url.searchParams.get('q') ?? '').includes('in parents'));
    assert.equal(lookups.length, 1);
    assert.match(lookups[0]!.url.searchParams.get('q')!, /'root' in parents/);
  });

  it('does not ask for them while a path resolves normally', async () => {
    // The list of roots costs a call, and most accounts have none. It is worth
    // asking on the way to a 404, not on the way to a folder that was found.
    respondWith((call) => {
      if (call.url.pathname.endsWith('/drives')) return json({ drives: [] });
      const q = call.url.searchParams.get('q') ?? '';
      if (q.includes("name = 'Documents'")) {
        return json({ files: [{ id: 'folder-docs', mimeType: GOOGLE_DRIVE_FOLDER_MIME }] });
      }
      return json({ files: [{ id: 'f1', name: 'a.txt', mimeType: 'text/plain' }] });
    });

    await adapter.listFolder(TOKENS, '/Documents');

    assert.equal(calls.filter((c) => c.url.pathname.endsWith('/drives')).length, 0);
  });

  it('walks a path that goes through a shared drive', async () => {
    respondWith((call) => {
      if (call.url.pathname.endsWith('/drives')) {
        return json({ drives: [{ id: 'drive-marketing', name: 'Marketing' }] });
      }
      const q = call.url.searchParams.get('q') ?? '';
      // 'Marketing' is not a folder under root - it is a shared drive - so the
      // walk misses, consults the roots, and carries on from there.
      if (q.includes("name = '2026'")) {
        return json({ files: [{ id: 'folder-2026', mimeType: GOOGLE_DRIVE_FOLDER_MIME }] });
      }
      return json({ files: [] });
    });

    await adapter.listFolder(TOKENS, '/Shared drives/Marketing/2026');

    // The walk starts at the shared drive rather than at `root`, which is the
    // only place `2026` could have been found.
    const lookup = calls.find((c) => (c.url.searchParams.get('q') ?? '').includes("name = '2026'"));
    assert.ok(lookup!.url.searchParams.get('q')!.includes("'drive-marketing' in parents"));
  });

  it('opens one without ever using the synthetic folder as a parent', async () => {
    // Drive rejects an id it did not issue, and the throw used to skip the
    // fallback that knew what to do with it - so a shared drive listed fine
    // and 404'd the moment somebody clicked into it.
    respondWith((call) => {
      if (call.url.pathname.endsWith('/drives')) {
        return json({ drives: [{ id: '0AIshareddrive', name: 'PO Data' }] });
      }
      return json({ files: [{ id: 'f1', name: 'PO', mimeType: GOOGLE_DRIVE_FOLDER_MIME }] });
    });

    const page = await adapter.listFolder(TOKENS, '/Shared drives/PO Data');

    assert.deepEqual(page.files.map((f) => f.name), ['PO']);

    for (const call of calls) {
      assert.ok(
        !(call.url.searchParams.get('q') ?? '').includes('orbit:shared-drives'),
        'the synthetic id must never reach Drive',
      );
    }
  });

  it('still lists My Drive when the account cannot ask for shared drives', async () => {
    // A personal account returns an empty list; some refuse outright. Neither
    // is a reason to fail the listing.
    respondWith((call) => {
      if (call.url.pathname.endsWith('/drives')) return new Response('nope', { status: 403 });
      return json({ files: [{ id: 'f1', name: 'notes.txt', mimeType: 'text/plain' }] });
    });

    const page = await adapter.listFolder(TOKENS, '/');
    assert.deepEqual(page.files.map((f) => f.name), ['notes.txt']);
  });
});

describe('relocate', () => {
  it('copies into the destination without touching the original', async () => {
    respondWith((call) => {
      if (call.url.pathname.endsWith('/drives')) return json({ drives: [] });
      const q = call.url.searchParams.get('q') ?? '';
      if (q.includes("name = 'Archive'")) {
        return json({ files: [{ id: 'folder-archive', mimeType: GOOGLE_DRIVE_FOLDER_MIME }] });
      }
      if (call.url.pathname.endsWith('/copy')) {
        return json({ id: 'copy-1', name: 'a.jpg', mimeType: 'image/jpeg' });
      }
      return json({ files: [] });
    });

    const file = await adapter.relocate(TOKENS, 'file-1', '/Archive', { copy: true });

    const copy = calls.find((c) => c.url.pathname.endsWith('/copy'))!;
    assert.equal(copy.method, 'POST');
    assert.deepEqual(JSON.parse(copy.body!), { parents: ['folder-archive'] });
    assert.equal(file.virtualPath, '/Archive/a.jpg');

    assert.equal(calls.some((c) => c.method === 'DELETE'), false);
  });

  it('moves by naming both the old parent and the new one', async () => {
    // A Drive file can sit in several folders at once, so "add to that one"
    // alone would leave it in the old one as well.
    respondWith((call) => {
      if (call.url.pathname.endsWith('/drives')) return json({ drives: [] });
      const q = call.url.searchParams.get('q') ?? '';
      if (q.includes("name = 'Archive'")) {
        return json({ files: [{ id: 'folder-archive', mimeType: GOOGLE_DRIVE_FOLDER_MIME }] });
      }
      if (call.url.searchParams.get('fields') === 'parents') {
        return json({ parents: ['folder-old', 'folder-other'] });
      }
      if (call.method === 'PATCH') {
        return json({ id: 'file-1', name: 'a.jpg', mimeType: 'image/jpeg' });
      }
      return json({ files: [] });
    });

    await adapter.relocate(TOKENS, 'file-1', '/Archive', { copy: false });

    const patch = calls.find((c) => c.method === 'PATCH')!;
    assert.equal(patch.url.searchParams.get('addParents'), 'folder-archive');
    assert.equal(patch.url.searchParams.get('removeParents'), 'folder-old,folder-other');
  });
});

describe('what the mirror is fed', () => {
  it('enumerates the account\'s own corpus, not every drive it can see', async () => {
    // The mirror feeds the storage breakdown, the duplicate finder and search.
    // Shared drive content is not this account's - Google does not count it
    // against the allowance either - so pulling it in made a 15 GB Drive
    // report a breakdown of storage it does not own and cannot free.
    respondWith(() => json({ files: [] }));

    await adapter.listAllFiles(TOKENS);

    assert.equal(calls[0]!.url.searchParams.get('corpora'), 'user');
    assert.equal(calls[0]!.url.searchParams.get('includeItemsFromAllDrives'), null);
  });

  it('still keeps the checksum, which is what proves a duplicate', async () => {
    respondWith(() => json({ files: [] }));
    await adapter.listAllFiles(TOKENS);

    assert.match(calls[0]!.url.searchParams.get('fields')!, /md5Checksum/);
  });
});
