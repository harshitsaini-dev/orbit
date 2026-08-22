import { schedules } from '@orbit/db';
import { and, asc, eq, lte } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../lib/db.js';
import { syncAccount } from './sync.js';
import { queueTransfer, runTransfer } from './transfers.js';

/**
 * Jobs that run again on their own.
 *
 * Described by a preset and a time rather than a cron expression: cron is a
 * good machine format and a poor thing to ask someone to write, and "every
 * Sunday at 2am" is what people actually mean.
 *
 * The instance this runs on sleeps after fifteen minutes idle, so a schedule
 * whose moment passes while nothing is awake simply does not fire. Everything
 * here is therefore built to **run late rather than skip**: due-ness is a
 * comparison against a stored time, not an event, so waking up at 6am finds the
 * 2am job still waiting.
 */

export type Every = 'hourly' | 'daily' | 'weekly' | 'monthly';
export type Action = 'sync' | 'backup';

export interface PublicSchedule {
  id: string;
  name: string;
  action: Action;
  config: Record<string, unknown>;
  every: Every;
  hour: number;
  minute: number;
  weekday: number | null;
  dayOfMonth: number | null;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastMessage: string | null;
}

type ScheduleRow = typeof schedules.$inferSelect;

function toPublic(row: ScheduleRow): PublicSchedule {
  return {
    id: row.id,
    name: row.name,
    action: row.action as Action,
    config: JSON.parse(row.config) as Record<string, unknown>,
    every: row.every as Every,
    hour: row.hour,
    minute: row.minute,
    weekday: row.weekday,
    dayOfMonth: row.dayOfMonth,
    enabled: row.enabled,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    lastStatus: row.lastStatus,
    lastMessage: row.lastMessage,
  };
}

export interface Timing {
  every: Every;
  hour: number;
  minute: number;
  weekday?: number | null;
  dayOfMonth?: number | null;
}

/**
 * The next moment a schedule is due, strictly after `from`.
 *
 * Strictly after matters: computed from the run that has just happened, "at or
 * after" would return the same instant and the job would run in a loop until
 * the minute ticked over.
 */
export function nextRun(timing: Timing, from: Date = new Date()): Date {
  const next = new Date(from.getTime());
  next.setSeconds(0, 0);

  if (timing.every === 'hourly') {
    next.setMinutes(timing.minute);
    if (next <= from) next.setTime(next.getTime() + 3_600_000);
    return next;
  }

  next.setHours(timing.hour, timing.minute, 0, 0);

  if (timing.every === 'daily') {
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }

  if (timing.every === 'weekly') {
    const target = timing.weekday ?? 0;
    // Days until the target weekday, then a whole week if that lands in the
    // past - which it does whenever today *is* the day but the time has gone.
    const ahead = (target - next.getDay() + 7) % 7;
    next.setDate(next.getDate() + ahead);
    if (next <= from) next.setDate(next.getDate() + 7);
    return next;
  }

  const target = timing.dayOfMonth ?? 1;
  next.setDate(target);
  if (next <= from) {
    // Rolling the month with setMonth on the 31st lands in the following month
    // for a short one, so the day is set again afterwards - and clamped, since
    // "the 31st" in February means the last day of it.
    next.setDate(1);
    next.setMonth(next.getMonth() + 1);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(target, lastDay));
  }

  return next;
}

export interface CreateInput extends Timing {
  userId: string;
  name: string;
  action: Action;
  config: Record<string, unknown>;
}

export async function createSchedule(input: CreateInput): Promise<PublicSchedule> {
  const [row] = await db()
    .insert(schedules)
    .values({
      id: nanoid(),
      ownerId: input.userId,
      name: input.name,
      action: input.action,
      config: JSON.stringify(input.config),
      every: input.every,
      hour: input.hour,
      minute: input.minute,
      weekday: input.weekday ?? null,
      dayOfMonth: input.dayOfMonth ?? null,
      nextRunAt: nextRun(input).toISOString(),
    })
    .returning();

  if (!row) throw new Error('Failed to create schedule');
  return toPublic(row);
}

export async function listSchedules(userId: string): Promise<PublicSchedule[]> {
  const rows = await db()
    .select()
    .from(schedules)
    .where(eq(schedules.ownerId, userId))
    .orderBy(asc(schedules.nextRunAt));

  return rows.map(toPublic);
}

export async function setEnabled(
  userId: string,
  id: string,
  enabled: boolean,
): Promise<boolean> {
  const [row] = await db()
    .update(schedules)
    .set({ enabled })
    .where(and(eq(schedules.id, id), eq(schedules.ownerId, userId)))
    .returning();

  return Boolean(row);
}

export async function deleteSchedule(userId: string, id: string): Promise<boolean> {
  const [row] = await db()
    .delete(schedules)
    .where(and(eq(schedules.id, id), eq(schedules.ownerId, userId)))
    .returning();

  return Boolean(row);
}

/** Runs one schedule and records how it went. Never throws. */
export async function runSchedule(row: ScheduleRow): Promise<void> {
  let status = 'ok';
  let message = '';

  try {
    const config = JSON.parse(row.config) as Record<string, string>;

    if (row.action === 'sync') {
      const result = await syncAccount(row.ownerId, config['accountId'] ?? '');
      status = result.status;
      message = `${result.changed} changed, ${result.deleted} removed`;
      if (result.message) message += ` — ${result.message}`;
    } else if (row.action === 'backup') {
      const transfer = await queueTransfer({
        userId: row.ownerId,
        sourceAccountId: config['sourceAccountId'] ?? '',
        sourceRemoteId: config['sourceRemoteId'] ?? '',
        targetAccountId: config['targetAccountId'] ?? '',
        targetPath: config['targetPath'] ?? '/',
      });

      if (!transfer) {
        status = 'error';
        message = 'An account in this backup is no longer connected';
      } else {
        // Awaited rather than fired: the tick is the only thing running, and a
        // second one is a minute away.
        await runTransfer(transfer.id);
        message = `Copied ${transfer.name}`;
      }
    } else {
      status = 'error';
      message = `Unknown action: ${row.action}`;
    }
  } catch (err) {
    status = 'error';
    message = err instanceof Error ? err.message : 'The job failed';
  }

  // The next time is computed from now, not from when it was due: a job that
  // ran six hours late because nothing was awake should not then fire six more
  // times catching up.
  await db()
    .update(schedules)
    .set({
      lastRunAt: new Date().toISOString(),
      lastStatus: status,
      lastMessage: message.slice(0, 500),
      nextRunAt: nextRun({
        every: row.every as Every,
        hour: row.hour,
        minute: row.minute,
        weekday: row.weekday,
        dayOfMonth: row.dayOfMonth,
      }).toISOString(),
    })
    .where(eq(schedules.id, row.id));
}

/**
 * Runs one schedule on demand, leaving its own timetable alone.
 *
 * `runSchedule` recomputes `nextRunAt` from now, which is right when the job
 * fired because it was due and wrong when somebody pressed a button - pressing
 * "run now" at 4pm should not move a nightly job to 4pm tomorrow. So the time
 * is put back afterwards.
 */
export async function runScheduleNow(
  userId: string,
  id: string,
): Promise<PublicSchedule | null> {
  const [row] = await db()
    .select()
    .from(schedules)
    .where(and(eq(schedules.id, id), eq(schedules.ownerId, userId)))
    .limit(1);

  if (!row) return null;

  const due = row.nextRunAt;
  await runSchedule(row);
  await db().update(schedules).set({ nextRunAt: due }).where(eq(schedules.id, id));

  const [updated] = await db().select().from(schedules).where(eq(schedules.id, id));
  return updated ? toPublic(updated) : null;
}

/**
 * Everything due, run in order.
 *
 * Called on every tick and once on start-up, which is what makes "run late"
 * work: after a night asleep the first tick finds whatever was missed.
 */
export async function runDue(now: Date = new Date()): Promise<number> {
  const due = await db()
    .select()
    .from(schedules)
    .where(and(eq(schedules.enabled, true), lte(schedules.nextRunAt, now.toISOString())))
    .orderBy(asc(schedules.nextRunAt));

  for (const row of due) await runSchedule(row);
  return due.length;
}
