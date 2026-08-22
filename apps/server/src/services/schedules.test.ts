import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

const { createSchedule, listSchedules, nextRun, runDue, setEnabled } = await import(
  './schedules.js'
);
const { createAccount } = await import('./accounts.js');
const { getLocalUser } = await import('./users.js');
const { useTestDatabase } = await import('../test-utils.js');
const { getAdapter } = await import('@orbit/adapters');
const { db } = await import('../lib/db.js');
const { schedules } = await import('@orbit/db');
const { eq } = await import('drizzle-orm');

const drive = getAdapter('google_drive');
const pristine = {
  listAllFiles: drive.listAllFiles.bind(drive),
  listChangesSince: drive.listChangesSince.bind(drive),
};

beforeEach(async () => {
  await useTestDatabase();
  Object.assign(drive, pristine);
  (drive as unknown as Record<string, unknown>).listAllFiles = async () => ({ files: [] });
  (drive as unknown as Record<string, unknown>).listChangesSince = async () => ({
    changed: [],
    deletedRemoteIds: [],
    cursor: 'c1',
    hasMore: false,
  });
});

async function seedAccount(nickname = 'me@example.com') {
  const user = await getLocalUser();
  const account = await createAccount({
    userId: user.id,
    provider: 'google_drive',
    catalogueKey: 'google_drive',
    nickname,
    remoteAccountId: nickname,
    tokens: {
      accessToken: 'access-sentinel',
      refreshToken: 'refresh-sentinel',
      expiresAt: Date.now() + 3_600_000,
    },
  });
  return { userId: user.id, accountId: account.id };
}

describe('working out when a job is next due', () => {
  it('finds the next daily slot, today or tomorrow', () => {
    const morning = new Date('2026-08-22T09:00:00');

    assert.equal(
      nextRun({ every: 'daily', hour: 14, minute: 30 }, morning).toISOString().slice(0, 16),
      new Date('2026-08-22T14:30:00').toISOString().slice(0, 16),
    );

    // Already gone today, so tomorrow.
    assert.equal(
      nextRun({ every: 'daily', hour: 2, minute: 0 }, morning).toISOString().slice(0, 10),
      new Date('2026-08-23T02:00:00').toISOString().slice(0, 10),
    );
  });

  it('never returns the moment it was given', () => {
    // Computed from the run that just happened, "at or after" would return the
    // same instant and the job would fire in a loop until the minute ticked.
    const exact = new Date('2026-08-22T02:00:00');
    assert.ok(nextRun({ every: 'daily', hour: 2, minute: 0 }, exact) > exact);
    assert.ok(nextRun({ every: 'hourly', hour: 0, minute: 0 }, exact) > exact);
  });

  it('finds the right weekday, and a whole week on when today has passed', () => {
    // 2026-08-22 is a Saturday.
    const saturday = new Date('2026-08-22T09:00:00');

    const sunday = nextRun({ every: 'weekly', hour: 2, minute: 0, weekday: 0 }, saturday);
    assert.equal(sunday.getDay(), 0);
    assert.equal(sunday.getDate(), 23);

    // Today is Saturday but 2am has gone, so next Saturday.
    const nextSaturday = nextRun({ every: 'weekly', hour: 2, minute: 0, weekday: 6 }, saturday);
    assert.equal(nextSaturday.getDay(), 6);
    assert.equal(nextSaturday.getDate(), 29);
  });

  it('clamps a monthly day that a short month does not have', () => {
    // "The 31st" in February means the last day of it, not the 3rd of March.
    const january = new Date('2026-01-31T09:00:00');
    const next = nextRun({ every: 'monthly', hour: 2, minute: 0, dayOfMonth: 31 }, january);

    assert.equal(next.getMonth(), 1, 'February');
    assert.equal(next.getDate(), 28);
  });

  it('rolls an hourly job to the next hour', () => {
    const at = new Date('2026-08-22T09:40:00');
    const next = nextRun({ every: 'hourly', hour: 0, minute: 15 }, at);

    assert.equal(next.getHours(), 10);
    assert.equal(next.getMinutes(), 15);
  });
});

describe('running what is due', () => {
  it('runs a job whose moment has passed, rather than skipping it', async () => {
    // The instance sleeps, so a schedule's moment routinely passes with nothing
    // awake. Due-ness is a comparison against a stored time, not an event.
    const { userId, accountId } = await seedAccount();

    const schedule = await createSchedule({
      userId,
      name: 'Nightly sync',
      action: 'sync',
      config: { accountId },
      every: 'daily',
      hour: 2,
      minute: 0,
    });

    // Six hours overdue, as if nothing had been awake since 2am.
    await db()
      .update(schedules)
      .set({ nextRunAt: new Date(Date.now() - 6 * 3_600_000).toISOString() })
      .where(eq(schedules.id, schedule.id));

    assert.equal(await runDue(), 1);

    const [row] = await db().select().from(schedules).where(eq(schedules.id, schedule.id));
    assert.equal(row!.lastStatus, 'ok');
    assert.ok(row!.lastRunAt);
  });

  it('does not then fire repeatedly to catch up', async () => {
    // The next time is computed from now, not from when it was due.
    const { userId, accountId } = await seedAccount();

    const schedule = await createSchedule({
      userId,
      name: 'Hourly sync',
      action: 'sync',
      config: { accountId },
      every: 'hourly',
      hour: 0,
      minute: 0,
    });

    await db()
      .update(schedules)
      .set({ nextRunAt: new Date(Date.now() - 10 * 3_600_000).toISOString() })
      .where(eq(schedules.id, schedule.id));

    await runDue();
    assert.equal(await runDue(), 0, 'ten missed hours must not become ten runs');
  });

  it('leaves a disabled job alone', async () => {
    const { userId, accountId } = await seedAccount();
    const schedule = await createSchedule({
      userId,
      name: 'Paused',
      action: 'sync',
      config: { accountId },
      every: 'daily',
      hour: 2,
      minute: 0,
    });

    await setEnabled(userId, schedule.id, false);
    await db()
      .update(schedules)
      .set({ nextRunAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(schedules.id, schedule.id));

    assert.equal(await runDue(), 0);
  });

  it('records a failure without stopping the tick', async () => {
    const { userId } = await seedAccount();

    const schedule = await createSchedule({
      userId,
      name: 'Broken',
      action: 'sync',
      config: { accountId: 'no-such-account' },
      every: 'daily',
      hour: 2,
      minute: 0,
    });

    await db()
      .update(schedules)
      .set({ nextRunAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(schedules.id, schedule.id));

    assert.equal(await runDue(), 1);

    const [row] = await db().select().from(schedules).where(eq(schedules.id, schedule.id));
    assert.equal(row!.lastStatus, 'error');
    // And it is still scheduled, rather than quietly abandoned.
    assert.ok(new Date(row!.nextRunAt) > new Date());
  });

  it('refuses a backup whose accounts are gone, and says so', async () => {
    const { userId } = await seedAccount();

    const schedule = await createSchedule({
      userId,
      name: 'Weekly backup',
      action: 'backup',
      config: { sourceAccountId: 'gone', sourceRemoteId: 'x', targetAccountId: 'also-gone' },
      every: 'weekly',
      hour: 2,
      minute: 0,
      weekday: 0,
    });

    await db()
      .update(schedules)
      .set({ nextRunAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(schedules.id, schedule.id));

    await runDue();

    const [row] = await db().select().from(schedules).where(eq(schedules.id, schedule.id));
    assert.equal(row!.lastStatus, 'error');
    assert.match(row!.lastMessage ?? '', /no longer connected/);
  });
});

describe('managing schedules', () => {
  it('lists them soonest first', async () => {
    const { userId, accountId } = await seedAccount();

    await createSchedule({
      userId,
      name: 'Monthly',
      action: 'sync',
      config: { accountId },
      every: 'monthly',
      hour: 2,
      minute: 0,
      dayOfMonth: 1,
    });
    await createSchedule({
      userId,
      name: 'Hourly',
      action: 'sync',
      config: { accountId },
      every: 'hourly',
      hour: 0,
      minute: 0,
    });

    const listed = await listSchedules(userId);
    assert.equal(listed[0]!.name, 'Hourly');
  });

  it('never shows another user\'s schedules', async () => {
    const { userId, accountId } = await seedAccount();
    await createSchedule({
      userId,
      name: 'Mine',
      action: 'sync',
      config: { accountId },
      every: 'daily',
      hour: 2,
      minute: 0,
    });

    assert.deepEqual(await listSchedules('somebody-else'), []);
  });
});
