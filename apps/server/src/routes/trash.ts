import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { listTrash, purge, purgeMany, restore, restoreMany } from '../services/trash.js';
import { record } from '../services/audit.js';
import { sendProviderError } from '../lib/provider-error.js';

/**
 * The bin, across every drive that keeps one.
 *
 * Restoring and destroying are separate routes with separate permissions
 * because they are opposite acts: one puts a file back, the other is the only
 * thing in Orbit with nothing behind it.
 */
export const trashRouter = Router();

const target = z.object({ accountId: z.string().min(1), remoteId: z.string().min(1) });

/**
 * A selection, capped.
 *
 * Two hundred at a time. Each one is a request to a provider, so an unbounded
 * list is an unbounded number of them held open by a single HTTP call - and a
 * selection larger than this is somebody emptying the whole bin, which is
 * better done as several rounds it can report on than one that might time out.
 */
const targets = z.object({
  files: z.array(target).min(1).max(200),
});

trashRouter.get('/api/trash', requireAuth, async (req, res, next) => {
  try {
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    res.json(await listTrash(req.user!.id, { cursor }));
  } catch (err) {
    if (!sendProviderError(err, res)) next(err);
  }
});

trashRouter.post('/api/trash/restore', requireAuth, async (req, res, next) => {
  const parsed = target.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'A file is required' } });
    return;
  }

  try {
    const result = await restore(req.user!.id, parsed.data.accountId, parsed.data.remoteId);

    if (!result.ok) {
      res.status(result.reason === 'unsupported' ? 400 : 404).json({
        error: {
          code: result.reason,
          message:
            result.reason === 'unsupported'
              ? 'That drive keeps no bin to restore from'
              : 'No such account',
        },
      });
      return;
    }

    await record({
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'file.relocate',
      accountId: parsed.data.accountId,
      targetType: 'file',
      targetId: parsed.data.remoteId,
      summary: 'Restored a file from the bin',
      ip: req.ip,
    });

    res.status(204).end();
  } catch (err) {
    if (!sendProviderError(err, res)) next(err);
  }
});

/**
 * Restores or destroys a whole selection.
 *
 * 207 when the batch was mixed, so a caller cannot read a 200 as "all done" -
 * the same rule the bulk delete of live files follows.
 */
trashRouter.post('/api/trash/restore-many', requireAuth, async (req, res, next) => {
  const parsed = targets.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'A selection is required' } });
    return;
  }

  try {
    const outcome = await restoreMany(req.user!.id, parsed.data.files);

    if (outcome.succeeded.length > 0) {
      await record({
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: 'file.relocate',
        accountId: outcome.succeeded[0]!.accountId,
        targetType: 'file',
        summary: `Restored ${outcome.succeeded.length} ${outcome.succeeded.length === 1 ? 'file' : 'files'} from the bin`,
        ip: req.ip,
      });
    }

    res.status(outcome.failed.length > 0 ? 207 : 200).json(outcome);
  } catch (err) {
    if (!sendProviderError(err, res)) next(err);
  }
});

trashRouter.post('/api/trash/purge-many', requireAuth, async (req, res, next) => {
  const parsed = targets.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'A selection is required' } });
    return;
  }

  try {
    const outcome = await purgeMany(req.user!.id, parsed.data.files);

    if (outcome.succeeded.length > 0) {
      await record({
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: 'file.delete',
        accountId: outcome.succeeded[0]!.accountId,
        targetType: 'file',
        summary: `Destroyed ${outcome.succeeded.length} ${outcome.succeeded.length === 1 ? 'file' : 'files'} in the bin`,
        ip: req.ip,
      });
    }

    res.status(outcome.failed.length > 0 ? 207 : 200).json(outcome);
  } catch (err) {
    if (!sendProviderError(err, res)) next(err);
  }
});

trashRouter.delete('/api/trash', requireAuth, async (req, res, next) => {
  const parsed = target.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'A file is required' } });
    return;
  }

  try {
    const result = await purge(req.user!.id, parsed.data.accountId, parsed.data.remoteId);

    if (!result.ok) {
      res.status(result.reason === 'unsupported' ? 400 : 404).json({
        error: {
          code: result.reason,
          message:
            result.reason === 'unsupported'
              ? 'That drive will not let this account empty its bin early'
              : 'No such account',
        },
      });
      return;
    }

    await record({
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'file.delete',
      accountId: parsed.data.accountId,
      targetType: 'file',
      targetId: parsed.data.remoteId,
      // Named apart from an ordinary delete on purpose: this one had no bin
      // behind it.
      summary: 'Destroyed a file in the bin',
      ip: req.ip,
    });

    res.status(204).end();
  } catch (err) {
    if (!sendProviderError(err, res)) next(err);
  }
});
