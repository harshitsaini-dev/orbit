import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getAccountRow } from '../services/accounts.js';
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  runScheduleNow,
  setEnabled,
} from '../services/schedules.js';

/**
 * Jobs that run again on their own.
 *
 * Described by a preset and a time rather than a cron expression: cron is a
 * good machine format and a poor thing to ask somebody to write, and "every
 * Sunday at 2am" is what people actually mean by it.
 */
export const schedulesRouter = Router();

const timing = z.object({
  every: z.enum(['hourly', 'daily', 'weekly', 'monthly']),
  hour: z.number().int().min(0).max(23).default(2),
  minute: z.number().int().min(0).max(59).default(0),
  weekday: z.number().int().min(0).max(6).nullish(),
  dayOfMonth: z.number().int().min(1).max(31).nullish(),
});

const createSchema = z
  .discriminatedUnion('action', [
    z.object({
      action: z.literal('sync'),
      accountId: z.string().min(1),
    }),
    z.object({
      action: z.literal('backup'),
      sourceAccountId: z.string().min(1),
      sourceRemoteId: z.string().min(1),
      targetAccountId: z.string().min(1),
      targetPath: z.string().default('/'),
    }),
  ])
  .and(timing)
  .and(z.object({ name: z.string().trim().min(1).max(80) }));

schedulesRouter.get('/api/schedules', requireAuth, async (req, res, next) => {
  try {
    res.json({ schedules: await listSchedules(req.user!.id) });
  } catch (err) {
    next(err);
  }
});

schedulesRouter.post('/api/schedules', requireAuth, async (req, res, next) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: 'invalid_request', message: 'That is not a schedule Orbit can run' },
    });
    return;
  }

  const input = parsed.data;

  try {
    /**
     * The drives are checked here rather than at run time, at the level the job
     * will actually need. A backup that turns out on its first firing to have
     * been pointed at a read-only drive has already cost the user a week of
     * believing it was running.
     */
    const needed =
      input.action === 'sync'
        ? ([[input.accountId, 'read'] as const])
        : ([
            [input.sourceAccountId, 'read'] as const,
            [input.targetAccountId, 'write'] as const,
          ]);

    for (const [accountId, need] of needed) {
      if (!(await getAccountRow(req.user!.id, accountId, need))) {
        res.status(404).json({
          error: {
            code: 'not_found',
            message:
              need === 'write'
                ? 'You cannot write to that drive'
                : 'No such account',
          },
        });
        return;
      }
    }

    const config =
      input.action === 'sync'
        ? { accountId: input.accountId }
        : {
            sourceAccountId: input.sourceAccountId,
            sourceRemoteId: input.sourceRemoteId,
            targetAccountId: input.targetAccountId,
            targetPath: input.targetPath,
          };

    const schedule = await createSchedule({
      userId: req.user!.id,
      name: input.name,
      action: input.action,
      config,
      every: input.every,
      hour: input.hour,
      minute: input.minute,
      weekday: input.weekday ?? null,
      dayOfMonth: input.dayOfMonth ?? null,
    });

    res.status(201).json({ schedule });
  } catch (err) {
    next(err);
  }
});

schedulesRouter.patch('/api/schedules/:id', requireAuth, async (req, res, next) => {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'enabled must be true or false' } });
    return;
  }

  try {
    if (!(await setEnabled(req.user!.id, req.params.id!, parsed.data.enabled))) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such schedule' } });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * Runs it now, without disturbing when it next runs on its own.
 *
 * Mostly so somebody can find out whether a job they just set up actually
 * works, rather than waiting until 2am to discover it does not.
 */
schedulesRouter.post('/api/schedules/:id/run', requireAuth, async (req, res, next) => {
  try {
    const schedule = await runScheduleNow(req.user!.id, req.params.id!);
    if (!schedule) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such schedule' } });
      return;
    }
    res.json({ schedule });
  } catch (err) {
    next(err);
  }
});

schedulesRouter.delete('/api/schedules/:id', requireAuth, async (req, res, next) => {
  try {
    if (!(await deleteSchedule(req.user!.id, req.params.id!))) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such schedule' } });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
