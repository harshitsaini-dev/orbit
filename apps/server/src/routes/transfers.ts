import { Router } from 'express';
import { z } from 'zod';
import { hub } from '../lib/ws.js';
import { requireAuth } from '../middleware/auth.js';
import {
  cancelTransfer,
  listTransfers,
  queueTransfer,
  runTransfer,
} from '../services/transfers.js';

export const transfersRouter: Router = Router();

/**
 * One at a time, across the whole process.
 *
 * A transfer holds a chunk in memory at each end. Two at once on a 512MB
 * instance is how both of them fail, and a queue that finishes one file is more
 * use than three that all stall.
 */
let running: Promise<void> = Promise.resolve();

function enqueue(id: string): void {
  running = running.then(() =>
    runTransfer(id, (transferred) => {
      hub.publish(`transfer:${id}`, { type: 'transfer:progress', id, transferred });
    }).then(() => {
      hub.publish(`transfer:${id}`, { type: 'transfer:done', id });
    }),
  );
}

const queueSchema = z.object({
  sourceAccountId: z.string().min(1),
  sourceRemoteId: z.string().min(1),
  targetAccountId: z.string().min(1),
  targetPath: z.string().default('/'),
  /** A move rather than a copy. The source goes only after the copy lands. */
  deleteSource: z.boolean().default(false),
});

transfersRouter.post('/api/transfers', requireAuth, async (req, res, next) => {
  const parsed = queueSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Malformed transfer' } });
    return;
  }

  if (parsed.data.sourceAccountId === parsed.data.targetAccountId) {
    // Within one account this is a move, which the provider does natively and
    // without moving any bytes at all.
    res.status(400).json({
      error: {
        code: 'invalid_request',
        message: 'Both ends are the same account. Rename or move it there instead.',
      },
    });
    return;
  }

  try {
    const transfer = await queueTransfer({ userId: req.user!.id, ...parsed.data });
    if (!transfer) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such account' } });
      return;
    }

    enqueue(transfer.id);
    res.status(201).json({ transfer });
  } catch (err) {
    if (err instanceof Error && err.message.includes('Folders cannot')) {
      res.status(400).json({ error: { code: 'unsupported', message: err.message } });
      return;
    }
    next(err);
  }
});

transfersRouter.get('/api/transfers', requireAuth, async (req, res, next) => {
  try {
    res.json({ transfers: await listTransfers(req.user!.id) });
  } catch (err) {
    next(err);
  }
});

transfersRouter.post('/api/transfers/:id/resume', requireAuth, async (req, res, next) => {
  try {
    const mine = (await listTransfers(req.user!.id)).find(
      (transfer) => transfer.id === req.params.id,
    );

    if (!mine) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such transfer' } });
      return;
    }
    if (mine.state === 'done' || mine.state === 'running') {
      res.status(409).json({ error: { code: 'conflict', message: `Already ${mine.state}` } });
      return;
    }

    enqueue(mine.id);
    res.status(202).json({ transfer: { ...mine, state: 'queued' } });
  } catch (err) {
    next(err);
  }
});

transfersRouter.delete('/api/transfers/:id', requireAuth, async (req, res, next) => {
  try {
    const cancelled = await cancelTransfer(req.user!.id, req.params.id ?? '');
    if (!cancelled) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such transfer' } });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
