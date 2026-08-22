import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

const { cancelTransfer, listTransfers, queueTransfer, recoverInterrupted, runTransfer } =
  await import('./transfers.js');
const { createAccount } = await import('./accounts.js');
const { getLocalUser } = await import('./users.js');
const { useTestDatabase } = await import('../test-utils.js');
const { getAdapter } = await import('@orbit/adapters');
const { db } = await import('../lib/db.js');
const { accounts, transfers } = await import('@orbit/db');
const { eq } = await import('drizzle-orm');

const drive = getAdapter('google_drive');
const pristine = {
  getFileMeta: drive.getFileMeta.bind(drive),
  getFileStream: drive.getFileStream.bind(drive),
  initUpload: drive.initUpload.bind(drive),
  uploadChunk: drive.uploadChunk.bind(drive),
  remove: drive.remove.bind(drive),
};

/** What the fake provider was asked to do, in order. */
let calls: string[] = [];
let removed: string[] = [];
let sourceBytes: Uint8Array;

function stubProvider(options: { size?: number; chunkSize?: number; failAtChunk?: number } = {}): void {
  const size = options.size ?? 24;
  const chunkSize = options.chunkSize ?? 8;
  sourceBytes = new Uint8Array(size).map((_, index) => index % 251);

  calls = [];
  removed = [];

  const set = (name: string, value: unknown) => {
    (drive as unknown as Record<string, unknown>)[name] = value;
  };

  set('getFileMeta', async () => ({
    remoteId: 'source-file',
    name: 'movie.mp4',
    virtualPath: '/movie.mp4',
    mimeType: 'video/mp4',
    sizeBytes: size,
    isFolder: false,
    starred: false,
    modifiedAt: '2026-08-01T10:00:00.000Z',
  }));

  set('getFileStream', async (_tokens: unknown, _id: string, range?: { start: number; end?: number }) => {
    const start = range?.start ?? 0;
    const end = Math.min(range?.end ?? size - 1, size - 1);
    calls.push(`read ${start}-${end}`);
    return {
      stream: new Blob([sourceBytes.slice(start, end + 1) as unknown as BlobPart]).stream(),
      contentType: 'video/mp4',
      contentLength: end - start + 1,
    };
  });

  set('initUpload', async () => {
    calls.push('init');
    return {
      provider: 'google_drive',
      remoteSessionId: 'session-1',
      chunkSize,
      state: { received: 0 },
    };
  });

  let chunkIndex = 0;
  set('uploadChunk', async (session: { state: { received: number } }, chunk: Uint8Array) => {
    chunkIndex += 1;
    if (options.failAtChunk === chunkIndex) throw new Error('the destination refused a chunk');

    session.state.received += chunk.byteLength;
    calls.push(`write ${chunk.byteLength}`);
    return { done: session.state.received >= size };
  });

  set('remove', async (_tokens: unknown, ids: string[]) => {
    removed.push(...ids);
    return { succeeded: ids, failed: [] };
  });
}

function restore(): void {
  for (const [name, fn] of Object.entries(pristine)) {
    (drive as unknown as Record<string, unknown>)[name] = fn;
  }
}

beforeEach(async () => {
  await useTestDatabase();
  restore();
});

async function seedPair() {
  const user = await getLocalUser();
  const tokens = {
    accessToken: 'access-sentinel',
    refreshToken: 'refresh-sentinel',
    expiresAt: Date.now() + 3_600_000,
  };

  const source = await createAccount({
    userId: user.id,
    provider: 'google_drive',
    catalogueKey: 'google_drive',
    nickname: 'source@example.com',
    remoteAccountId: 'source@example.com',
    tokens,
  });

  const target = await createAccount({
    userId: user.id,
    provider: 'google_drive',
    catalogueKey: 'google_drive',
    nickname: 'target@example.com',
    remoteAccountId: 'target@example.com',
    tokens,
  });

  return { userId: user.id, source, target };
}

describe('queueing a transfer', () => {
  it('records what is moving and where', async () => {
    stubProvider();
    const { userId, source, target } = await seedPair();

    const transfer = await queueTransfer({
      userId,
      sourceAccountId: source.id,
      sourceRemoteId: 'source-file',
      targetAccountId: target.id,
      targetPath: '/Videos',
    });

    assert.equal(transfer?.name, 'movie.mp4');
    assert.equal(transfer?.sizeBytes, 24);
    assert.equal(transfer?.state, 'queued');
    assert.equal(transfer?.targetPath, '/Videos');
  });

  it('refuses a folder rather than queueing something it cannot do', async () => {
    stubProvider();
    (drive as unknown as Record<string, unknown>).getFileMeta = async () => ({
      remoteId: 'a-folder',
      name: 'Photos',
      virtualPath: '/Photos',
      mimeType: 'application/vnd.google-apps.folder',
      sizeBytes: 0,
      isFolder: true,
      starred: false,
      modifiedAt: '2026-08-01T10:00:00.000Z',
    });

    const { userId, source, target } = await seedPair();

    await assert.rejects(
      () =>
        queueTransfer({
          userId,
          sourceAccountId: source.id,
          sourceRemoteId: 'a-folder',
          targetAccountId: target.id,
        }),
      /Folders cannot/,
    );
  });

  it('refuses an account that is not the caller\'s', async () => {
    stubProvider();
    const { userId, source } = await seedPair();

    assert.equal(
      await queueTransfer({
        userId,
        sourceAccountId: source.id,
        sourceRemoteId: 'source-file',
        targetAccountId: 'not-mine',
      }),
      null,
    );
  });
});

describe('running a transfer', () => {
  it('streams the file across in chunks, in order', async () => {
    stubProvider({ size: 24, chunkSize: 8 });
    const { userId, source, target } = await seedPair();

    const transfer = (await queueTransfer({
      userId,
      sourceAccountId: source.id,
      sourceRemoteId: 'source-file',
      targetAccountId: target.id,
    }))!;

    await runTransfer(transfer.id);

    // One ranged read per chunk rather than one long stream: a stream held open
    // across a chunked upload dies with the process, and a range can be asked
    // for again.
    assert.deepEqual(calls, [
      'init',
      'read 0-7',
      'write 8',
      'read 8-15',
      'write 8',
      'read 16-23',
      'write 8',
    ]);

    const [row] = await db().select().from(transfers).where(eq(transfers.id, transfer.id));
    assert.equal(row!.state, 'done');
    assert.equal(row!.transferredBytes, 24);
  });

  it('records progress after every chunk, so a restart can resume', async () => {
    stubProvider({ size: 24, chunkSize: 8, failAtChunk: 3 });
    const { userId, source, target } = await seedPair();

    const transfer = (await queueTransfer({
      userId,
      sourceAccountId: source.id,
      sourceRemoteId: 'source-file',
      targetAccountId: target.id,
    }))!;

    await runTransfer(transfer.id);

    const [row] = await db().select().from(transfers).where(eq(transfers.id, transfer.id));
    assert.equal(row!.state, 'failed');
    // Two chunks landed before the third was refused, and the position says so.
    assert.equal(row!.transferredBytes, 16);
    assert.match(row!.error ?? '', /refused a chunk/);
  });

  it('resumes from where it stopped rather than starting again', async () => {
    stubProvider({ size: 24, chunkSize: 8, failAtChunk: 3 });
    const { userId, source, target } = await seedPair();

    const transfer = (await queueTransfer({
      userId,
      sourceAccountId: source.id,
      sourceRemoteId: 'source-file',
      targetAccountId: target.id,
    }))!;

    await runTransfer(transfer.id);

    // Second attempt, with the destination no longer refusing.
    stubProvider({ size: 24, chunkSize: 8 });
    await runTransfer(transfer.id);

    // Only the last chunk: the first sixteen bytes were not read again.
    assert.deepEqual(calls, ['read 16-23', 'write 8']);

    const [row] = await db().select().from(transfers).where(eq(transfers.id, transfer.id));
    assert.equal(row!.state, 'done');
  });

  it('deletes the source only after the copy has landed', async () => {
    stubProvider({ size: 16, chunkSize: 8 });
    const { userId, source, target } = await seedPair();

    const transfer = (await queueTransfer({
      userId,
      sourceAccountId: source.id,
      sourceRemoteId: 'source-file',
      targetAccountId: target.id,
      deleteSource: true,
    }))!;

    await runTransfer(transfer.id);

    assert.deepEqual(removed, ['source-file']);
    // The delete is the last thing that happens; the other order loses the file
    // when the upload fails.
    assert.equal(calls.at(-1), 'write 8');
  });

  it('does not delete the source when the copy failed', async () => {
    stubProvider({ size: 16, chunkSize: 8, failAtChunk: 1 });
    const { userId, source, target } = await seedPair();

    const transfer = (await queueTransfer({
      userId,
      sourceAccountId: source.id,
      sourceRemoteId: 'source-file',
      targetAccountId: target.id,
      deleteSource: true,
    }))!;

    await runTransfer(transfer.id);

    assert.deepEqual(removed, [], 'the file must still exist somewhere');
  });

  it('stops when cancelled mid-flight', async () => {
    stubProvider({ size: 800, chunkSize: 8 });
    const { userId, source, target } = await seedPair();

    const transfer = (await queueTransfer({
      userId,
      sourceAccountId: source.id,
      sourceRemoteId: 'source-file',
      targetAccountId: target.id,
    }))!;

    // Cancel after the first chunk by watching the row change.
    const run = runTransfer(transfer.id, (transferred) => {
      if (transferred >= 8) void cancelTransfer(userId, transfer.id);
    });
    await run;

    const [row] = await db().select().from(transfers).where(eq(transfers.id, transfer.id));
    assert.equal(row!.state, 'cancelled');
    assert.ok(row!.transferredBytes < 800, 'it should not have finished');
  });

  it('adds what it moved to the destination account', async () => {
    stubProvider({ size: 16, chunkSize: 8 });
    const { userId, source, target } = await seedPair();

    const transfer = (await queueTransfer({
      userId,
      sourceAccountId: source.id,
      sourceRemoteId: 'source-file',
      targetAccountId: target.id,
    }))!;

    await runTransfer(transfer.id);

    const [row] = await db().select().from(accounts).where(eq(accounts.id, target.id));
    assert.equal(row!.uploadedViaOrbitBytes, 16);
  });
});

describe('after a restart', () => {
  it('marks anything left running as paused, with a reason', async () => {
    // A row saying "running" with nothing running is what an interrupted
    // transfer looks like; left alone it claims progress it is not making.
    stubProvider();
    const { userId, source, target } = await seedPair();

    const transfer = (await queueTransfer({
      userId,
      sourceAccountId: source.id,
      sourceRemoteId: 'source-file',
      targetAccountId: target.id,
    }))!;

    await db().update(transfers).set({ state: 'running' }).where(eq(transfers.id, transfer.id));

    assert.equal(await recoverInterrupted(), 1);

    const [row] = await db().select().from(transfers).where(eq(transfers.id, transfer.id));
    assert.equal(row!.state, 'paused');
    assert.match(row!.error ?? '', /Resume/);
  });
});

describe('cancelling', () => {
  it('refuses to cancel one that has already finished', async () => {
    stubProvider({ size: 8, chunkSize: 8 });
    const { userId, source, target } = await seedPair();

    const transfer = (await queueTransfer({
      userId,
      sourceAccountId: source.id,
      sourceRemoteId: 'source-file',
      targetAccountId: target.id,
    }))!;

    await runTransfer(transfer.id);

    // Saying it was cancelled would be a lie about a file that has moved.
    assert.equal(await cancelTransfer(userId, transfer.id), false);
    assert.equal((await listTransfers(userId))[0]!.state, 'done');
  });
});
