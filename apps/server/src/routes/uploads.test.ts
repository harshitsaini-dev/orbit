import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.API_RATE_LIMIT = '10000';

const { createApp } = await import('../app.js');
const { clearPendingUploads, pendingUploadCount } = await import('./uploads.js');
const { useTestDatabase } = await import('../test-utils.js');
const { createAccount } = await import('../services/accounts.js');
const { getLocalUser } = await import('../services/users.js');
const { getAdapter } = await import('@orbit/adapters');

const drive = getAdapter('google_drive');
const pristine = {
  initUpload: drive.initUpload.bind(drive),
  uploadChunk: drive.uploadChunk.bind(drive),
};

function stub(name: keyof typeof pristine, fn: unknown): void {
  (drive as unknown as Record<string, unknown>)[name] = fn;
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
  Object.assign(drive, pristine);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  await useTestDatabase();
  clearPendingUploads();
  Object.assign(drive, pristine);

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

function stubHappyUpload(chunkSize = 4) {
  const received: Buffer[] = [];

  stub('initUpload', async () => ({
    provider: 'google_drive',
    remoteSessionId: 'session-1',
    uploadUrl: 'https://upload.example/session-1',
    chunkSize,
    state: { offset: 0, totalBytes: 0, virtualPath: '/x' },
  }));

  stub('uploadChunk', async (session: { state: { offset: number } }, chunk: Uint8Array, onProgress: (n: number) => void) => {
    received.push(Buffer.from(chunk));
    const total = received.reduce((sum, part) => sum + part.length, 0);
    onProgress(total);

    // Signals "finished" once the declared size has arrived.
    const done = total >= (session.state as unknown as { declared: number }).declared;
    return done
      ? {
          done: true,
          file: {
            remoteId: 'new-file',
            name: 'x.bin',
            virtualPath: '/x.bin',
            mimeType: 'application/octet-stream',
            sizeBytes: total,
            isFolder: false,
            starred: false,
            modifiedAt: '2026-01-01T00:00:00.000Z',
          },
        }
      : { done: false };
  });

  return received;
}

async function init(body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId, path: '/', mimeType: 'application/octet-stream', ...body }),
  });
}

function sendChunk(uploadId: string, chunk: Buffer) {
  return fetch(`${baseUrl}/api/uploads/${uploadId}/chunk`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    // A Buffer is a Uint8Array view; fetch types want the plain array form.
    body: new Uint8Array(chunk),
  });
}

describe('POST /api/uploads', () => {
  it('starts a session and returns a chunk size and channel', async () => {
    stubHappyUpload(8);

    const res = await init({ name: 'x.bin', sizeBytes: 16 });
    assert.equal(res.status, 201);

    const body = (await res.json()) as { uploadId: string; chunkSize: number; wsChannel: string };
    assert.ok(body.uploadId);
    assert.equal(body.chunkSize, 8);
    // Scoped to the upload, so one client cannot watch another's progress.
    assert.equal(body.wsChannel, `upload:${body.uploadId}`);
  });

  it('404s for an account the user does not have', async () => {
    const res = await init({ accountId: 'nope', name: 'x.bin', sizeBytes: 1 });
    assert.equal(res.status, 404);
  });

  it('rejects a nameless or negative-sized upload', async () => {
    assert.equal((await init({ name: '  ', sizeBytes: 1 })).status, 400);
    assert.equal((await init({ name: 'x', sizeBytes: -1 })).status, 400);
  });

  it('reports a provider that cannot accept uploads as 501', async () => {
    stub('initUpload', async () => {
      const err = new Error('not implemented');
      err.name = 'NotImplementedError';
      throw err;
    });

    assert.equal((await init({ name: 'x.bin', sizeBytes: 1 })).status, 501);
  });
});

describe('PUT /api/uploads/:id/chunk', () => {
  it('passes raw bytes through unchanged, in order', async () => {
    const received = stubHappyUpload(4);

    const res = await init({ name: 'x.bin', sizeBytes: 10 });
    const { uploadId } = (await res.json()) as { uploadId: string };

    // The declared size lives on the session so the stub knows when to finish.
    stub('uploadChunk', (() => {
      let total = 0;
      return async (_session: unknown, chunk: Uint8Array, onProgress: (n: number) => void) => {
        received.push(Buffer.from(chunk));
        total += chunk.byteLength;
        onProgress(total);
        return total >= 10
          ? {
              done: true,
              file: {
                remoteId: 'f',
                name: 'x.bin',
                virtualPath: '/x.bin',
                mimeType: 'application/octet-stream',
                sizeBytes: total,
                isFolder: false,
                starred: false,
                modifiedAt: '2026-01-01T00:00:00.000Z',
              },
            }
          : { done: false };
      };
    })());

    received.length = 0;
    assert.equal((await sendChunk(uploadId, Buffer.from('ABCD'))).status, 200);
    assert.equal((await sendChunk(uploadId, Buffer.from('EFGH'))).status, 200);

    const last = await sendChunk(uploadId, Buffer.from('IJ'));
    const body = (await last.json()) as { done: boolean; file?: { remoteId: string } };

    assert.equal(body.done, true);
    assert.equal(body.file?.remoteId, 'f');
    // The bytes must arrive exactly as sent - no JSON parsing, no re-encoding.
    assert.equal(Buffer.concat(received).toString(), 'ABCDEFGHIJ');
  });

  it('forgets the upload once it finishes, rather than leaking the session', async () => {
    stubHappyUpload(64);
    stub('uploadChunk', async (_s: unknown, chunk: Uint8Array, onProgress: (n: number) => void) => {
      onProgress(chunk.byteLength);
      return {
        done: true,
        file: {
          remoteId: 'f',
          name: 'x.bin',
          virtualPath: '/x.bin',
          mimeType: 'application/octet-stream',
          sizeBytes: chunk.byteLength,
          isFolder: false,
          starred: false,
          modifiedAt: '2026-01-01T00:00:00.000Z',
        },
      };
    });

    const { uploadId } = (await (await init({ name: 'x.bin', sizeBytes: 4 })).json()) as { uploadId: string };
    assert.equal(pendingUploadCount(), 1);

    await sendChunk(uploadId, Buffer.from('ABCD'));
    assert.equal(pendingUploadCount(), 0);
  });

  it('drops the upload when the provider fails, so a broken session is not retried forever', async () => {
    stubHappyUpload(64);
    stub('uploadChunk', async () => {
      throw new Error('provider exploded');
    });

    const { uploadId } = (await (await init({ name: 'x.bin', sizeBytes: 4 })).json()) as { uploadId: string };

    const res = await sendChunk(uploadId, Buffer.from('ABCD'));
    assert.equal(res.status, 500);
    assert.equal(pendingUploadCount(), 0);
  });

  it('404s for an upload id that was never issued', async () => {
    assert.equal((await sendChunk('made-up', Buffer.from('A'))).status, 404);
  });

  it('rejects an empty chunk', async () => {
    stubHappyUpload(64);
    const { uploadId } = (await (await init({ name: 'x.bin', sizeBytes: 4 })).json()) as { uploadId: string };

    assert.equal((await sendChunk(uploadId, Buffer.alloc(0))).status, 400);
  });
});

describe('DELETE /api/uploads/:id', () => {
  it('abandons an upload, releasing the provider session', async () => {
    stubHappyUpload(64);
    const { uploadId } = (await (await init({ name: 'x.bin', sizeBytes: 4 })).json()) as { uploadId: string };

    assert.equal(pendingUploadCount(), 1);
    assert.equal((await fetch(`${baseUrl}/api/uploads/${uploadId}`, { method: 'DELETE' })).status, 204);
    assert.equal(pendingUploadCount(), 0);
  });

  it('is silent about an id that does not exist', async () => {
    assert.equal((await fetch(`${baseUrl}/api/uploads/nope`, { method: 'DELETE' })).status, 204);
  });
});
