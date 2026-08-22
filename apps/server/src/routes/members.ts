import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getAccountRow } from '../services/accounts.js';
import { listForAccount, record } from '../services/audit.js';
import { invite, listMembers, revoke, setLevel, LEVELS, type Level } from '../services/sharing.js';

/**
 * Who else may use a drive.
 *
 * Every route here needs `manage`, which only the owner and an admin guest
 * have. A caller without it is answered 404 rather than 403 throughout: a
 * guest with read access should not be able to learn who else is on the drive,
 * and "you may not manage this" tells them there is a member list to see.
 */
export const membersRouter = Router();

const levelSchema = z.enum(LEVELS as unknown as [Level, ...Level[]]);

const inviteSchema = z.object({
  // Trimmed and lowercased in the service; validated here only for shape.
  email: z.string().email().max(254),
  level: levelSchema,
});

const notFound = { error: { code: 'not_found', message: 'No such account' } };

membersRouter.get('/api/accounts/:id/members', requireAuth, async (req, res, next) => {
  try {
    const account = await getAccountRow(req.user!.id, req.params.id!, 'manage');
    if (!account) {
      res.status(404).json(notFound);
      return;
    }

    res.json({ members: await listMembers(account.id), owner: account.userId === req.user!.id });
  } catch (err) {
    next(err);
  }
});

/**
 * What has been done to this drive.
 *
 * Gated on `manage` like the member list, and for the same reason: who deleted
 * what is not a reader's business, and a 404 rather than a 403 keeps the fact
 * that there is a log from being confirmed.
 */
membersRouter.get('/api/accounts/:id/activity', requireAuth, async (req, res, next) => {
  try {
    const account = await getAccountRow(req.user!.id, req.params.id!, 'manage');
    if (!account) {
      res.status(404).json(notFound);
      return;
    }

    res.json({ entries: await listForAccount(account.id) });
  } catch (err) {
    next(err);
  }
});

membersRouter.post('/api/accounts/:id/members', requireAuth, async (req, res, next) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: 'invalid_request', message: 'An email address and an access level are required' },
    });
    return;
  }

  try {
    const account = await getAccountRow(req.user!.id, req.params.id!, 'manage');
    if (!account) {
      res.status(404).json(notFound);
      return;
    }

    const result = await invite({
      accountId: account.id,
      ownerId: account.userId,
      grantedBy: req.user!.id,
      email: parsed.data.email,
      level: parsed.data.level,
    });

    if (!result.ok) {
      res.status(409).json({
        error: {
          code: 'already_has_access',
          message:
            result.reason === 'owner'
              ? 'That address owns this drive already'
              : 'That is your own address',
        },
      });
      return;
    }

    await record({
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'member.invite',
      accountId: account.id,
      targetType: 'user',
      targetId: result.member.userId,
      summary: `Gave ${result.member.email} ${parsed.data.level} access`,
      ip: req.ip,
    });

    res.status(201).json({ member: result.member });
  } catch (err) {
    next(err);
  }
});

membersRouter.patch('/api/accounts/:id/members/:userId', requireAuth, async (req, res, next) => {
  const parsed = z.object({ level: levelSchema }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'An access level is required' } });
    return;
  }

  try {
    const account = await getAccountRow(req.user!.id, req.params.id!, 'manage');
    if (!account) {
      res.status(404).json(notFound);
      return;
    }

    // An admin guest may not change their own level - that is the one edit that
    // would let them promote themselves past whoever invited them.
    if (req.params.userId === req.user!.id) {
      res.status(403).json({
        error: { code: 'not_allowed', message: 'You cannot change your own access' },
      });
      return;
    }

    if (!(await setLevel(account.id, req.params.userId!, parsed.data.level))) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such member' } });
      return;
    }

    await record({
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'member.level',
      accountId: account.id,
      targetType: 'user',
      targetId: req.params.userId!,
      summary: `Changed access to ${parsed.data.level}`,
      ip: req.ip,
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

membersRouter.delete('/api/accounts/:id/members/:userId', requireAuth, async (req, res, next) => {
  try {
    const account = await getAccountRow(req.user!.id, req.params.id!, 'manage');
    if (!account) {
      res.status(404).json(notFound);
      return;
    }

    // Removing yourself is allowed - leaving a drive you were added to is not
    // the same as promoting yourself, and the owner has no grant row to lose.
    if (!(await revoke(account.id, req.params.userId!))) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such member' } });
      return;
    }

    await record({
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'member.revoke',
      accountId: account.id,
      targetType: 'user',
      targetId: req.params.userId!,
      summary: 'Removed access',
      ip: req.ip,
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
