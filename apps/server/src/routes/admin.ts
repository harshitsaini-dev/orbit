import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import {
  activeSessions,
  listUsers,
  overview,
  recentActivity,
  removeUser,
  setRole,
} from '../services/admin.js';
import { record } from '../services/audit.js';

/**
 * The console for whoever runs this instance.
 *
 * Every route is behind `requireRole('superadmin')`, which answers 404 rather
 * than 403 - the existence of an admin surface is not something to confirm to
 * somebody who may not use it.
 *
 * What is deliberately absent is as much the point as what is here. There is no
 * way to browse somebody's files, open one, or see what is in their drives.
 * Orbit's promise is that it holds nothing, and an admin console that walked
 * around that would make the promise false - with the operator, the one person
 * best placed to break it, holding the key.
 */
export const adminRouter = Router();

const superadmin = requireRole('superadmin');

adminRouter.get('/api/admin/overview', superadmin, async (_req, res, next) => {
  try {
    res.json(await overview());
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/api/admin/users', superadmin, async (_req, res, next) => {
  try {
    res.json({ users: await listUsers() });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/api/admin/activity', superadmin, async (_req, res, next) => {
  try {
    res.json({ entries: await recentActivity() });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/api/admin/sessions', superadmin, async (_req, res, next) => {
  try {
    res.json({ sessions: await activeSessions() });
  } catch (err) {
    next(err);
  }
});

const REFUSALS: Record<string, { status: number; message: string }> = {
  not_found: { status: 404, message: 'No such user' },
  self: { status: 403, message: 'You cannot change your own role or remove yourself' },
  last_admin: {
    status: 409,
    message: 'That is the only administrator. Promote somebody else first.',
  },
};

adminRouter.patch('/api/admin/users/:id', superadmin, async (req, res, next) => {
  const parsed = z.object({ role: z.enum(['user', 'superadmin']) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'A role is required' } });
    return;
  }

  try {
    const result = await setRole(req.user!.id, req.params.id!, parsed.data.role);
    if (!result.ok) {
      const refusal = REFUSALS[result.reason]!;
      res.status(refusal.status).json({ error: { code: result.reason, message: refusal.message } });
      return;
    }

    await record({
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'member.level',
      targetType: 'user',
      targetId: req.params.id!,
      summary: `Set role to ${parsed.data.role}`,
      ip: req.ip,
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/api/admin/users/:id', superadmin, async (req, res, next) => {
  try {
    const result = await removeUser(req.user!.id, req.params.id!);
    if (!result.ok) {
      const refusal = REFUSALS[result.reason]!;
      res.status(refusal.status).json({ error: { code: result.reason, message: refusal.message } });
      return;
    }

    await record({
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'member.revoke',
      targetType: 'user',
      targetId: req.params.id!,
      summary: 'Removed a user and everything of theirs',
      ip: req.ip,
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
