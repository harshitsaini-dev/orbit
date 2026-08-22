import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'hosted';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_SECRET ??= 'test-session-secret';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.API_RATE_LIMIT = '10000';

const { createApp } = await import('../app.js');
const { useTestDatabase } = await import('../test-utils.js');
const { createAccount } = await import('../services/accounts.js');
const { createSession } = await import('../services/session.js');
const { findOrCreateByEmail } = await import('../services/users.js');
const { invite } = await import('../services/sharing.js');
const { getAdapter } = await import('@orbit/adapters');

const drive = getAdapter('google_drive');
const pristine = {
  listAllFiles: drive.listAllFiles.bind(drive),
  listChangesSince: drive.listChangesSince.bind(drive),
};

let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  Object.assign(drive, pristine);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

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

async function signIn(email: string): Promise<{ id: string; cookie: string }> {
  const user = await findOrCreateByEmail(email);
  const { token } = await createSession(user.id);
  return { id: user.id, cookie: `orbit_session=${token}` };
}

async function seedDrive(userId: string, nickname: string) {
  return createAccount({
    userId,
    provider: 'google_drive',
    catalogueKey: 'google_drive',
    nickname,
    remoteAccountId: `${nickname}@example.com`,
    tokens: { accessToken: 'access-sentinel' },
  });
}

function call(
  path: string,
  cookie: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: { cookie, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

describe('creating a schedule', () => {
  it('takes a preset and a time rather than a cron expression', async () => {
    const me = await signIn('me@example.com');
    const account = await seedDrive(me.id, 'Work');

    const res = await call('/api/schedules', me.cookie, {
      method: 'POST',
      body: {
        name: 'Nightly sync',
        action: 'sync',
        accountId: account.id,
        every: 'daily',
        hour: 2,
        minute: 30,
      },
    });

    assert.equal(res.status, 201);
    const { schedule } = await res.json();
    assert.equal(schedule.every, 'daily');
    assert.ok(new Date(schedule.nextRunAt) > new Date(), 'and it is scheduled ahead');
  });

  it('refuses an hour that is not on the clock', async () => {
    const me = await signIn('me@example.com');
    const account = await seedDrive(me.id, 'Work');

    const res = await call('/api/schedules', me.cookie, {
      method: 'POST',
      body: { name: 'Bad', action: 'sync', accountId: account.id, every: 'daily', hour: 25 },
    });
    assert.equal(res.status, 400);
  });

  it('refuses a drive that is not the caller\'s', async () => {
    const me = await signIn('me@example.com');
    const other = await signIn('other@example.com');
    const theirs = await seedDrive(other.id, 'Theirs');

    const res = await call('/api/schedules', me.cookie, {
      method: 'POST',
      body: { name: 'Sneaky', action: 'sync', accountId: theirs.id, every: 'daily' },
    });
    assert.equal(res.status, 404);
  });

  it('checks a backup target for write, not merely for existing', async () => {
    // Otherwise the first firing at 2am is when the user finds out the job was
    // never going to work - after a week of believing it was running.
    const me = await signIn('me@example.com');
    const owner = await signIn('owner@example.com');

    const source = await seedDrive(me.id, 'Mine');
    const target = await seedDrive(owner.id, 'Shared');

    await invite({
      accountId: target.id,
      ownerId: owner.id,
      grantedBy: owner.id,
      email: 'me@example.com',
      level: 'read',
    });

    const body = {
      name: 'Weekly backup',
      action: 'backup',
      sourceAccountId: source.id,
      sourceRemoteId: 'file-1',
      targetAccountId: target.id,
      every: 'weekly',
      weekday: 0,
    };

    const denied = await call('/api/schedules', me.cookie, { method: 'POST', body });
    assert.equal(denied.status, 404);

    await invite({
      accountId: target.id,
      ownerId: owner.id,
      grantedBy: owner.id,
      email: 'me@example.com',
      level: 'write',
    });

    const allowed = await call('/api/schedules', me.cookie, { method: 'POST', body });
    assert.equal(allowed.status, 201);
  });
});

describe('listing and managing', () => {
  it('shows only the caller\'s own', async () => {
    const me = await signIn('me@example.com');
    const other = await signIn('other@example.com');

    const mine = await seedDrive(me.id, 'Mine');
    const theirs = await seedDrive(other.id, 'Theirs');

    await call('/api/schedules', me.cookie, {
      method: 'POST',
      body: { name: 'Mine', action: 'sync', accountId: mine.id, every: 'daily' },
    });
    await call('/api/schedules', other.cookie, {
      method: 'POST',
      body: { name: 'Theirs', action: 'sync', accountId: theirs.id, every: 'daily' },
    });

    const { schedules } = await (await call('/api/schedules', me.cookie)).json();
    assert.equal(schedules.length, 1);
    assert.equal(schedules[0].name, 'Mine');
  });

  it('pauses and resumes one', async () => {
    const me = await signIn('me@example.com');
    const account = await seedDrive(me.id, 'Work');

    const { schedule } = await (
      await call('/api/schedules', me.cookie, {
        method: 'POST',
        body: { name: 'Nightly', action: 'sync', accountId: account.id, every: 'daily' },
      })
    ).json();

    assert.equal(
      (await call(`/api/schedules/${schedule.id}`, me.cookie, {
        method: 'PATCH',
        body: { enabled: false },
      })).status,
      204,
    );

    const { schedules } = await (await call('/api/schedules', me.cookie)).json();
    assert.equal(schedules[0].enabled, false);
  });

  it('will not let one person touch another\'s schedule', async () => {
    const me = await signIn('me@example.com');
    const other = await signIn('other@example.com');
    const account = await seedDrive(me.id, 'Work');

    const { schedule } = await (
      await call('/api/schedules', me.cookie, {
        method: 'POST',
        body: { name: 'Nightly', action: 'sync', accountId: account.id, every: 'daily' },
      })
    ).json();

    for (const init of [
      { method: 'PATCH', body: { enabled: false } },
      { method: 'DELETE' },
      { method: 'POST' },
    ]) {
      const path =
        init.method === 'POST' ? `/api/schedules/${schedule.id}/run` : `/api/schedules/${schedule.id}`;
      assert.equal((await call(path, other.cookie, init)).status, 404);
    }
  });

  it('deletes one', async () => {
    const me = await signIn('me@example.com');
    const account = await seedDrive(me.id, 'Work');

    const { schedule } = await (
      await call('/api/schedules', me.cookie, {
        method: 'POST',
        body: { name: 'Nightly', action: 'sync', accountId: account.id, every: 'daily' },
      })
    ).json();

    assert.equal(
      (await call(`/api/schedules/${schedule.id}`, me.cookie, { method: 'DELETE' })).status,
      204,
    );
    const { schedules } = await (await call('/api/schedules', me.cookie)).json();
    assert.deepEqual(schedules, []);
  });
});

describe('running one on demand', () => {
  it('runs it and reports how it went', async () => {
    const me = await signIn('me@example.com');
    const account = await seedDrive(me.id, 'Work');

    const { schedule } = await (
      await call('/api/schedules', me.cookie, {
        method: 'POST',
        body: { name: 'Nightly', action: 'sync', accountId: account.id, every: 'daily' },
      })
    ).json();

    const res = await call(`/api/schedules/${schedule.id}/run`, me.cookie, { method: 'POST' });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.schedule.lastStatus, 'ok');
    assert.ok(body.schedule.lastRunAt);
  });

  it('does not move when the job next runs on its own', async () => {
    // Pressing "run now" at four in the afternoon must not turn a nightly job
    // into a four-in-the-afternoon job.
    const me = await signIn('me@example.com');
    const account = await seedDrive(me.id, 'Work');

    const { schedule } = await (
      await call('/api/schedules', me.cookie, {
        method: 'POST',
        body: { name: 'Nightly', action: 'sync', accountId: account.id, every: 'daily', hour: 2 },
      })
    ).json();

    const after = await (
      await call(`/api/schedules/${schedule.id}/run`, me.cookie, { method: 'POST' })
    ).json();

    assert.equal(after.schedule.nextRunAt, schedule.nextRunAt);
  });
});
