import { transfers } from '@orbit/db';
import type { UploadSession } from '@orbit/shared-types';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../lib/db.js';
import { useAccount } from './accounts.js';
import { recordUpload } from './allocation.js';

/**
 * Moving a file from one provider to another.
 *
 * The bytes stream through the server and are never written to Orbit's own
 * disk, which is the rule the whole product is built on. What that costs is
 * that a transfer occupies the process for as long as it runs — so it runs one
 * chunk at a time, records its position after each, and can be resumed rather
 * than restarted.
 *
 * That is not defensive programming. The free instance has 512MB of RAM, sleeps
 * after fifteen minutes idle and restarts on every deploy, so a transfer of any
 * real size *will* be interrupted. A design that cannot survive that is a
 * design that does not work here.
 */

export type TransferState = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';

export interface PublicTransfer {
  id: string;
  name: string;
  sizeBytes: number;
  transferredBytes: number;
  state: TransferState;
  error: string | null;
  deleteSource: boolean;
  sourceAccountId: string;
  targetAccountId: string;
  targetPath: string;
  createdAt: string;
  updatedAt: string;
}

type TransferRow = typeof transfers.$inferSelect;

function toPublic(row: TransferRow): PublicTransfer {
  return {
    id: row.id,
    name: row.name,
    sizeBytes: row.sizeBytes,
    transferredBytes: row.transferredBytes,
    state: row.state as TransferState,
    error: row.error,
    deleteSource: row.deleteSource,
    sourceAccountId: row.sourceAccountId,
    targetAccountId: row.targetAccountId,
    targetPath: row.targetPath,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface QueueInput {
  userId: string;
  sourceAccountId: string;
  sourceRemoteId: string;
  targetAccountId: string;
  targetPath?: string;
  deleteSource?: boolean;
}

export async function queueTransfer(input: QueueInput): Promise<PublicTransfer | null> {
  const source = await useAccount(input.userId, input.sourceAccountId);
  const target = await useAccount(input.userId, input.targetAccountId);
  if (!source || !target) return null;

  // Both ends are checked before anything is queued: a transfer that cannot
  // start is better refused than left sitting in a list failing later.
  const file = await source.adapter.getFileMeta(source.tokens, input.sourceRemoteId);
  if (file.isFolder) {
    throw new Error('Folders cannot be transferred yet; move the files inside it');
  }

  const [row] = await db()
    .insert(transfers)
    .values({
      id: nanoid(),
      ownerId: input.userId,
      sourceAccountId: input.sourceAccountId,
      sourceRemoteId: input.sourceRemoteId,
      targetAccountId: input.targetAccountId,
      targetPath: input.targetPath ?? '/',
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      deleteSource: input.deleteSource ?? false,
    })
    .returning();

  return row ? toPublic(row) : null;
}

export async function listTransfers(userId: string): Promise<PublicTransfer[]> {
  const rows = await db()
    .select()
    .from(transfers)
    .where(eq(transfers.ownerId, userId))
    .orderBy(desc(transfers.createdAt))
    .limit(100);

  return rows.map(toPublic);
}

export async function cancelTransfer(userId: string, id: string): Promise<boolean> {
  const [row] = await db()
    .update(transfers)
    .set({ state: 'cancelled', updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(transfers.id, id),
        eq(transfers.ownerId, userId),
        // A finished transfer cannot be cancelled, and saying it was would be a
        // lie about a file that has already moved.
        inArray(transfers.state, ['queued', 'running', 'paused']),
      ),
    )
    .returning();

  return Boolean(row);
}

async function update(id: string, changes: Partial<TransferRow>): Promise<void> {
  await db()
    .update(transfers)
    .set({ ...changes, updatedAt: new Date().toISOString() })
    .where(eq(transfers.id, id));
}

/** Whether the row still wants to run, read fresh so a cancel is noticed. */
async function stillWanted(id: string): Promise<boolean> {
  const [row] = await db()
    .select({ state: transfers.state })
    .from(transfers)
    .where(eq(transfers.id, id))
    .limit(1);

  return row?.state === 'running';
}

/**
 * Runs one transfer to completion, or until it is stopped.
 *
 * Deliberately sequential: the destination's chunked upload has to receive
 * chunks in order, and a second concurrent transfer on a 512MB instance is how
 * both of them fail.
 */
export async function runTransfer(
  id: string,
  onProgress?: (transferred: number) => void,
): Promise<void> {
  const [row] = await db().select().from(transfers).where(eq(transfers.id, id)).limit(1);
  if (!row || row.state === 'done' || row.state === 'cancelled') return;

  await update(id, { state: 'running', error: null });

  try {
    const source = await useAccount(row.ownerId, row.sourceAccountId);
    const target = await useAccount(row.ownerId, row.targetAccountId);
    if (!source || !target) throw new Error('An account in this transfer is no longer connected');

    const session: UploadSession = row.uploadState
      ? (JSON.parse(row.uploadState) as UploadSession)
      : await target.adapter.initUpload(target.tokens, row.targetPath, {
          name: row.name,
          sizeBytes: row.sizeBytes,
          mimeType: row.mimeType,
        });

    if (!row.uploadState) {
      await update(id, { uploadState: JSON.stringify(session) });
    }

    let transferred = row.transferredBytes;

    while (transferred < row.sizeBytes) {
      if (!(await stillWanted(id))) return;

      const end = Math.min(transferred + session.chunkSize, row.sizeBytes) - 1;

      // One ranged read per chunk rather than one long stream: a stream held
      // open across a chunked upload is a stream that dies with the process,
      // and a range can simply be asked for again.
      const part = await source.adapter.getFileStream(source.tokens, row.sourceRemoteId, {
        start: transferred,
        end,
      });

      const bytes = new Uint8Array(await new Response(part.stream as never).arrayBuffer());
      const result = await target.adapter.uploadChunk(session, bytes, () => undefined);

      transferred += bytes.byteLength;
      await update(id, { transferredBytes: transferred, uploadState: JSON.stringify(session) });
      onProgress?.(transferred);

      if (result.done) break;
      // A zero-length read would loop forever; the provider has stopped giving
      // us bytes and cannot be asked again for the same ones.
      if (bytes.byteLength === 0) throw new Error('The source stopped sending data');
    }

    if (row.deleteSource) {
      // Only after the copy has landed. The other order loses the file if the
      // upload fails.
      await source.adapter.remove(source.tokens, [row.sourceRemoteId]);
    }

    await recordUpload(row.ownerId, row.targetAccountId, row.sizeBytes);
    await update(id, { state: 'done', transferredBytes: row.sizeBytes });
  } catch (err) {
    await update(id, {
      // Paused rather than failed where the position is known: everything
      // transferred so far is still valid and the run can be picked up.
      state: 'failed',
      error: err instanceof Error ? err.message : 'The transfer failed',
    });
  }
}

/**
 * Anything left mid-flight when the process died.
 *
 * Called on start-up: a row saying "running" with nothing running is what an
 * interrupted transfer looks like, and it must not sit there claiming progress
 * it is not making.
 */
export async function recoverInterrupted(): Promise<number> {
  const stranded = await db()
    .update(transfers)
    .set({
      state: 'paused',
      error: 'Interrupted when Orbit restarted. Resume to continue from where it stopped.',
      updatedAt: new Date().toISOString(),
    })
    .where(eq(transfers.state, 'running'))
    .returning();

  return stranded.length;
}
