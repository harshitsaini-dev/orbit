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
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  await useTestDatabase();
});

/** A signed-in person, as a cookie the tests can send. */
async function signIn(email: string): Promise<{ id: string; cookie: string }> {
  const user = await findOrCreateByEmail(email);
  const { token } = await createSession(user.id);
  return { id: user.id, cookie: `orbit_session=${token}` };
}

async function scene() {
  const owner = await signIn('owner@example.com');
  const guest = await signIn('guest@example.com');

  const account = await createAccount({
    userId: owner.id,
    provider: 'google_drive',
    catalogueKey: 'google_drive',
    nickname: 'Team Drive',
    remoteAccountId: 'team@example.com',
    tokens: { accessToken: 'access-sentinel' },
  });

  return { owner, guest, account };
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

describe('reading the member list', () => {
  it('shows it to the owner', async () => {
    const { owner, account } = await scene();

    const res = await call(`/api/accounts/${account.id}/members`, owner.cookie);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).members, []);
  });

  it('hides even the existence of it from an ordinary guest', async () => {
    // 404 rather than 403: telling a reader "you may not manage this" tells
    // them there is a member list, and who else is on a drive is not their
    // business to learn.
    const { owner, guest, account } = await scene();

    await invite({
      accountId: account.id,
      ownerId: owner.id,
      grantedBy: owner.id,
      email: 'guest@example.com',
      level: 'full',
    });

    const res = await call(`/api/accounts/${account.id}/members`, guest.cookie);
    assert.equal(res.status, 404);
  });

  it('answers a stranger the same way as a real drive that is not theirs', async () => {
    const { account } = await scene();
    const stranger = await signIn('nobody@example.com');

    const real = await call(`/api/accounts/${account.id}/members`, stranger.cookie);
    const madeUp = await call('/api/accounts/does-not-exist/members', stranger.cookie);

    assert.equal(real.status, 404);
    assert.equal(madeUp.status, 404);
    assert.deepEqual(await real.json(), await madeUp.json());
  });

  it('turns nobody away without a session', async () => {
    const { account } = await scene();
    const res = await fetch(`${baseUrl}/api/accounts/${account.id}/members`);
    assert.equal(res.status, 401);
  });
});

describe('adding somebody', () => {
  it('creates them, and reports them as not yet arrived', async () => {
    const { owner, account } = await scene();

    const res = await call(`/api/accounts/${account.id}/members`, owner.cookie, {
      method: 'POST',
      body: { email: 'new.person@example.com', level: 'write' },
    });

    assert.equal(res.status, 201);
    const { member } = await res.json();
    assert.equal(member.email, 'new.person@example.com');
    assert.equal(member.level, 'write');
    assert.equal(member.joinedAt, null);
  });

  it('marks them arrived once they have actually signed in', async () => {
    const { owner, account } = await scene();

    await call(`/api/accounts/${account.id}/members`, owner.cookie, {
      method: 'POST',
      body: { email: 'later@example.com', level: 'read' },
    });
    await signIn('later@example.com');

    const { members } = await (
      await call(`/api/accounts/${account.id}/members`, owner.cookie)
    ).json();
    assert.ok(members[0].joinedAt);
  });

  it('rejects a level that is not one of the four', async () => {
    const { owner, account } = await scene();

    const res = await call(`/api/accounts/${account.id}/members`, owner.cookie, {
      method: 'POST',
      body: { email: 'x@example.com', level: 'superuser' },
    });
    assert.equal(res.status, 400);
  });

  it('refuses to add the owner to their own drive', async () => {
    const { owner, account } = await scene();

    const res = await call(`/api/accounts/${account.id}/members`, owner.cookie, {
      method: 'POST',
      body: { email: 'owner@example.com', level: 'admin' },
    });
    assert.equal(res.status, 409);
  });

  it('lets an admin guest add somebody, and a full one not', async () => {
    const { owner, guest, account } = await scene();

    await invite({
      accountId: account.id,
      ownerId: owner.id,
      grantedBy: owner.id,
      email: 'guest@example.com',
      level: 'full',
    });

    const denied = await call(`/api/accounts/${account.id}/members`, guest.cookie, {
      method: 'POST',
      body: { email: 'third@example.com', level: 'read' },
    });
    assert.equal(denied.status, 404);

    await invite({
      accountId: account.id,
      ownerId: owner.id,
      grantedBy: owner.id,
      email: 'guest@example.com',
      level: 'admin',
    });

    const allowed = await call(`/api/accounts/${account.id}/members`, guest.cookie, {
      method: 'POST',
      body: { email: 'third@example.com', level: 'read' },
    });
    assert.equal(allowed.status, 201);
  });
});

describe('changing and removing', () => {
  it('changes a level', async () => {
    const { owner, guest, account } = await scene();

    await invite({
      accountId: account.id,
      ownerId: owner.id,
      grantedBy: owner.id,
      email: 'guest@example.com',
      level: 'read',
    });

    const res = await call(`/api/accounts/${account.id}/members/${guest.id}`, owner.cookie, {
      method: 'PATCH',
      body: { level: 'full' },
    });
    assert.equal(res.status, 204);

    const { members } = await (
      await call(`/api/accounts/${account.id}/members`, owner.cookie)
    ).json();
    assert.equal(members[0].level, 'full');
  });

  it('stops an admin guest promoting themselves', async () => {
    // The one edit that would let somebody outrank whoever invited them.
    const { owner, guest, account } = await scene();

    await invite({
      accountId: account.id,
      ownerId: owner.id,
      grantedBy: owner.id,
      email: 'guest@example.com',
      level: 'admin',
    });

    const res = await call(`/api/accounts/${account.id}/members/${guest.id}`, guest.cookie, {
      method: 'PATCH',
      body: { level: 'admin' },
    });
    assert.equal(res.status, 403);
  });

  it('removes somebody, and takes the drive off their list', async () => {
    const { owner, guest, account } = await scene();

    await invite({
      accountId: account.id,
      ownerId: owner.id,
      grantedBy: owner.id,
      email: 'guest@example.com',
      level: 'write',
    });

    const before = await (await call('/api/accounts', guest.cookie)).json();
    assert.equal(before.accounts.length, 1);
    assert.equal(before.accounts[0].isOwner, false);
    assert.equal(before.accounts[0].accessLevel, 'write');

    assert.equal(
      (
        await call(`/api/accounts/${account.id}/members/${guest.id}`, owner.cookie, {
          method: 'DELETE',
        })
      ).status,
      204,
    );

    const after = await (await call('/api/accounts', guest.cookie)).json();
    assert.deepEqual(after.accounts, []);
  });

  it('reports a member who was never there as missing', async () => {
    const { owner, guest, account } = await scene();

    const res = await call(`/api/accounts/${account.id}/members/${guest.id}`, owner.cookie, {
      method: 'DELETE',
    });
    assert.equal(res.status, 404);
  });
});

describe('what a guest may actually do with the files', () => {
  it('refuses a reader the delete route', async () => {
    const { owner, guest, account } = await scene();

    await invite({
      accountId: account.id,
      ownerId: owner.id,
      grantedBy: owner.id,
      email: 'guest@example.com',
      level: 'read',
    });

    const res = await call('/api/files', guest.cookie, {
      method: 'DELETE',
      body: { accountId: account.id, remoteIds: ['whatever'] },
    });
    assert.equal(res.status, 404);
  });

  it('refuses a writer the delete route but not the listing', async () => {
    const { owner, guest, account } = await scene();

    await invite({
      accountId: account.id,
      ownerId: owner.id,
      grantedBy: owner.id,
      email: 'guest@example.com',
      level: 'write',
    });

    const deleted = await call('/api/files', guest.cookie, {
      method: 'DELETE',
      body: { accountId: account.id, remoteIds: ['whatever'] },
    });
    assert.equal(deleted.status, 404);

    // The listing is reached - it fails at the provider, not at the gate.
    const listed = await call(`/api/files?accountId=${account.id}&path=%2F`, guest.cookie);
    assert.notEqual(listed.status, 404);
  });

  it('never lets a guest disconnect the drive', async () => {
    const { owner, guest, account } = await scene();

    await invite({
      accountId: account.id,
      ownerId: owner.id,
      grantedBy: owner.id,
      email: 'guest@example.com',
      level: 'admin',
    });

    const res = await call(`/api/accounts/${account.id}`, guest.cookie, { method: 'DELETE' });
    assert.equal(res.status, 404);

    // And the owner still can.
    assert.equal(
      (await call(`/api/accounts/${account.id}`, owner.cookie, { method: 'DELETE' })).status,
      204,
    );
  });
});
