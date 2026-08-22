import { Router } from 'express';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { UploadSession } from '@orbit/shared-types';
import { requireAuth } from '../middleware/auth.js';
import { useAccount } from '../services/accounts.js';
import { chooseAccount, recordUpload } from '../services/allocation.js';
import { forgetBreakdown } from '../services/breakdown.js';
import { hub } from '../lib/ws.js';

export const uploadsRouter: Router = Router();

/**
 * In-flight uploads. Held in memory because a provider's resumable session is
 * itself short-lived — persisting these would only preserve handles that the
 * provider has already forgotten.
 */
interface PendingUpload {
  userId: string;
  accountId: string;
  session: UploadSession;
  name: string;
  totalBytes: number;
  uploadedBytes: number;
  startedAt: number;
}

const pending = new Map<string, PendingUpload>();

/** An abandoned upload should not pin its session forever. */
const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000;

function sweep(now = Date.now()): void {
  for (const [id, upload] of pending) {
    if (now - upload.startedAt > UPLOAD_TTL_MS) pending.delete(id);
  }
}

const initBody = z.object({
  /**
   * Omitted to let Orbit decide. Several drives behaving as one only works if
   * something can pick, and the user's chosen strategy is that something.
   */
  accountId: z.string().min(1).optional(),
  path: z.string().default('/'),
  name: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string().default('application/octet-stream'),
});

uploadsRouter.post('/api/uploads', requireAuth, async (req, res, next) => {
  const parsed = initBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'A name and size are required' } });
    return;
  }

  try {
    sweep();

    let accountId = parsed.data.accountId;

    if (!accountId) {
      const chosen = await chooseAccount(req.user!.id, parsed.data.sizeBytes);
      if (!chosen) {
        // Told before a byte moves rather than partway through the transfer.
        res.status(507).json({
          error: {
            code: 'no_room',
            message: 'No connected account has room for this file.',
          },
        });
        return;
      }
      accountId = chosen.account.id;
    }

    const active = await useAccount(req.user!.id, accountId, 'write');
    if (!active) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such account' } });
      return;
    }

    const session = await active.adapter.initUpload(active.tokens, parsed.data.path, {
      name: parsed.data.name,
      sizeBytes: parsed.data.sizeBytes,
      mimeType: parsed.data.mimeType,
    });

    const uploadId = nanoid();
    pending.set(uploadId, {
      userId: req.user!.id,
      accountId,
      session,
      name: parsed.data.name,
      totalBytes: parsed.data.sizeBytes,
      uploadedBytes: 0,
      startedAt: Date.now(),
    });

    res.status(201).json({
      uploadId,
      // Returned even when the caller supplied it, so a client that let Orbit
      // choose learns where the file is going.
      accountId,
      chunkSize: session.chunkSize,
      // The channel is scoped to the upload, so one client cannot watch another's.
      wsChannel: `upload:${uploadId}`,
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'needs_reauth') {
      res.status(409).json({ error: { code: 'needs_reauth', message: 'This account needs to be reconnected' } });
      return;
    }
    if (err instanceof Error && err.name === 'NotImplementedError') {
      res.status(501).json({ error: { code: 'unsupported', message: 'This provider cannot accept uploads yet' } });
      return;
    }
    next(err);
  }
});

/**
 * One chunk, streamed straight to the provider.
 *
 * The body arrives raw rather than as multipart: this is one slice of one file
 * and wrapping it in a form encoding would cost a copy and a parse for nothing.
 */
uploadsRouter.put(
  '/api/uploads/:id/chunk',
  requireAuth,
  (req, res, next) => {
    // Collected here rather than by a body parser, which would try to interpret it.
    const chunks: Buffer[] = [];
    let bytes = 0;

    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      chunks.push(chunk);
    });
    req.on('end', () => {
      (req as unknown as { rawChunk: Buffer }).rawChunk = Buffer.concat(chunks, bytes);
      next();
    });
    req.on('error', next);
  },
  async (req, res, next) => {
    const uploadId = req.params.id!;
    const upload = pending.get(uploadId);

    if (!upload || upload.userId !== req.user!.id) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such upload' } });
      return;
    }

    const chunk = (req as unknown as { rawChunk?: Buffer }).rawChunk;
    if (!chunk?.length) {
      res.status(400).json({ error: { code: 'invalid_request', message: 'Empty chunk' } });
      return;
    }

    try {
      const active = await useAccount(upload.userId, upload.accountId, 'write');
      if (!active) {
        pending.delete(uploadId);
        res.status(404).json({ error: { code: 'not_found', message: 'No such account' } });
        return;
      }

      const result = await active.adapter.uploadChunk(upload.session, chunk, (uploadedBytes) => {
        upload.uploadedBytes = uploadedBytes;
        hub.publish(`upload:${uploadId}`, {
          type: 'upload:progress',
          uploadId,
          uploadedBytes,
          totalBytes: upload.totalBytes,
          pct: upload.totalBytes > 0 ? Math.round((uploadedBytes / upload.totalBytes) * 100) : 100,
        });
      });

      if (!result.done) {
        res.json({ done: false, uploadedBytes: upload.uploadedBytes });
        return;
      }

      pending.delete(uploadId);
      // The cached breakdown no longer reflects what is stored.
      forgetBreakdown(upload.userId, upload.accountId);
      // What the upload actually cost. least_used reads this, and the storage
      // figures drift from reality between quota refreshes without it.
      void recordUpload(upload.userId, upload.accountId, upload.totalBytes);

      if (result.file) {
        hub.publish(`upload:${uploadId}`, {
          type: 'upload:complete',
          uploadId,
          file: {
            ...result.file,
            id: result.file.remoteId,
            accountId: upload.accountId,
            provider: active.row.provider,
            accountNickname: active.row.nickname,
          },
        });
      }

      res.json({ done: true, file: result.file });
    } catch (err) {
      pending.delete(uploadId);
      hub.publish(`upload:${uploadId}`, {
        type: 'upload:error',
        uploadId,
        message: err instanceof Error ? err.message : 'Upload failed',
      });

      if (err instanceof Error && err.message === 'needs_reauth') {
        res.status(409).json({ error: { code: 'needs_reauth', message: 'This account needs to be reconnected' } });
        return;
      }
      next(err);
    }
  },
);

uploadsRouter.delete('/api/uploads/:id', requireAuth, (req, res) => {
  const upload = pending.get(req.params.id!);
  if (upload && upload.userId === req.user!.id) pending.delete(req.params.id!);
  res.status(204).end();
});

/** Test seam: the map is process-local, so a suite needs a way to clear it. */
export function clearPendingUploads(): void {
  pending.clear();
}

export function pendingUploadCount(): number {
  return pending.size;
}
