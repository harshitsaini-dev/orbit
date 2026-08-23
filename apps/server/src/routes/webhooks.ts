import { WEBHOOK_EVENT_NAMES } from '@orbit/shared-types';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { record } from '../services/audit.js';
import {
  checkTarget,
  createWebhook,
  deleteWebhook,
  listWebhooks,
  recentDeliveries,
  rotateSecret,
  sendTest,
  setActive,
} from '../services/webhooks.js';

export const webhooksRouter: Router = Router();

const createSchema = z.object({
  name: z.string().min(1).max(80),
  url: z.string().min(1).max(2048),
  events: z.array(z.enum(WEBHOOK_EVENT_NAMES as [string, ...string[]])).min(1),
});

webhooksRouter.get('/api/webhooks', requireAuth, async (req, res, next) => {
  try {
    res.json({ webhooks: await listWebhooks(req.user!.id) });
  } catch (err) {
    next(err);
  }
});

/**
 * Creating one, with the secret shown exactly once.
 *
 * The URL is checked before anything is written. A webhook address is a place
 * this server will make requests to on a user's say-so, so a URL pointing at a
 * private network is refused rather than stored and discovered later.
 */
webhooksRouter.post('/api/webhooks', requireAuth, async (req, res, next) => {
  const parsed = createSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: { code: 'invalid_request', message: 'A name, a URL and at least one event' },
    });
    return;
  }

  try {
    const target = await checkTarget(parsed.data.url);

    if (!target.ok) {
      res.status(400).json({ error: { code: 'bad_target', message: target.why } });
      return;
    }

    const made = await createWebhook({ userId: req.user!.id, ...parsed.data });

    await record({
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'webhook.create',
      targetId: made.webhook.id,
      summary: `Added a webhook to ${parsed.data.url}`,
      ip: req.ip,
    });

    res.status(201).json(made);
  } catch (err) {
    next(err);
  }
});

webhooksRouter.post('/api/webhooks/:id/rotate', requireAuth, async (req, res, next) => {
  try {
    const secret = await rotateSecret(req.user!.id, req.params.id!);

    if (!secret) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such webhook' } });
      return;
    }

    res.json({ secret });
  } catch (err) {
    next(err);
  }
});

webhooksRouter.patch('/api/webhooks/:id', requireAuth, async (req, res, next) => {
  const parsed = z.object({ active: z.boolean() }).safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'active must be a boolean' } });
    return;
  }

  try {
    const updated = await setActive(req.user!.id, req.params.id!, parsed.data.active);

    if (!updated) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such webhook' } });
      return;
    }

    res.json({ webhook: updated });
  } catch (err) {
    next(err);
  }
});

/** A made-up event, so somebody can watch their own receiver handle one. */
webhooksRouter.post('/api/webhooks/:id/test', requireAuth, async (req, res, next) => {
  try {
    const outcome = await sendTest(req.user!.id, req.params.id!);

    if (!outcome) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such webhook' } });
      return;
    }

    // 200 whatever the receiver said. The delivery was attempted; what came
    // back is the answer, not an error in this request.
    res.json({ delivery: outcome });
  } catch (err) {
    next(err);
  }
});

webhooksRouter.get('/api/webhooks/:id/deliveries', requireAuth, async (req, res, next) => {
  try {
    const deliveries = await recentDeliveries(req.user!.id, req.params.id!);

    if (deliveries === null) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such webhook' } });
      return;
    }

    res.json({ deliveries });
  } catch (err) {
    next(err);
  }
});

webhooksRouter.delete('/api/webhooks/:id', requireAuth, async (req, res, next) => {
  try {
    const removed = await deleteWebhook(req.user!.id, req.params.id!);

    if (!removed) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such webhook' } });
      return;
    }

    await record({
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'webhook.delete',
      targetId: req.params.id!,
      summary: 'Removed a webhook',
      ip: req.ip,
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
