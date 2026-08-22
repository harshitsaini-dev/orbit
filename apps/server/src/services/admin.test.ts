import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'hosted';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

const { listUsers, overview, removeUser, setRole } = await import('./admin.js');
const { createAccount } = await import('./accounts.js');
const { createShare } = await import('./shares.js');
const { findOrCreateByEmail } = await import('./users.js');
const { useTestDatabase } = await import('../test-utils.js');
const { db } = await import('../lib/db.js');
const { users } = await import('@orbit/db');
const { eq } = await import('drizzle-orm');
const { getAdapter } = await import('@orbit/adapters');

beforeEach(async () => {
  await useTestDatabase();
});

/** The first account to exist is the superadmin, so this makes one deliberately. */
async function admin(email = 'admin@example.com') {
  const user = await findOrCreateByEmail(email);
  await db().update(users).set({ role: 'superadmin' }).where(eq(users.id, user.id));
  return { ...user, role: 'superadmin' as const };
}

describe('what an operator can see', () => {
  it('counts the instance without touching anybody\'s files', async () => {
    const owner = await admin();
    await findOrCreateByEmail('somebody@example.com');

    await createAccount({
      userId: owner.id,
      provider: 'google_drive',
      catalogueKey: 'google_drive',
      nickname: 'drive',
      remoteAccountId: 'drive@example.com',
      tokens: { accessToken: 'a' },
    });

    const seen = await overview();
    assert.equal(seen.users, 2);
    assert.equal(seen.accounts, 1);
  });

  it('counts links that are still live, not every link ever made', async () => {
    // `eq(column, null)` is never true in SQL, so getting this wrong reports no
    // live links for ever without ever failing.
    const owner = await admin();
    const account = await createAccount({
      userId: owner.id,
      provider: 'google_drive',
      catalogueKey: 'google_drive',
      nickname: 'drive',
      remoteAccountId: 'drive@example.com',
      tokens: { accessToken: 'a' },
    });

    const drive = getAdapter('google_drive');
    (drive as unknown as Record<string, unknown>).getFileMeta = async () => ({
      remoteId: 'f1',
      name: 'a.pdf',
      virtualPath: '/a.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
      isFolder: false,
      starred: false,
      modifiedAt: new Date().toISOString(),
    });

    await createShare({
      userId: owner.id,
      accountId: account.id,
      remoteId: 'f1',
      permission: 'view',
    });

    assert.equal((await overview()).shares, 1);
  });

  it('lists somebody who has connected nothing', async () => {
    // Invited and never arrived, or signed up and stopped - which is most of
    // what an operator is looking at this list to find.
    await admin();
    await findOrCreateByEmail('never-connected@example.com');

    const listed = await listUsers();
    const quiet = listed.find((row) => row.email === 'never-connected@example.com');

    assert.ok(quiet);
    assert.equal(quiet.accounts, 0);
    assert.equal(quiet.lastSeenAt, null);
  });
});

describe('changing what somebody may do', () => {
  it('promotes and demotes', async () => {
    const owner = await admin();
    const other = await findOrCreateByEmail('other@example.com');

    assert.deepEqual(await setRole(owner.id, other.id, 'superadmin'), { ok: true });
    assert.deepEqual(await setRole(owner.id, other.id, 'user'), { ok: true });
  });

  it('refuses to let anybody change their own role', async () => {
    const owner = await admin();
    assert.deepEqual(await setRole(owner.id, owner.id, 'user'), { ok: false, reason: 'self' });
  });

  it('refuses to demote the last administrator', async () => {
    // An instance with no administrator has no way back short of editing the
    // database by hand.
    const owner = await admin();
    const other = await findOrCreateByEmail('other@example.com');

    assert.deepEqual(await setRole(other.id, owner.id, 'user'), {
      ok: false,
      reason: 'last_admin',
    });

    // With a second one, the first may step down.
    await setRole(owner.id, other.id, 'superadmin');
    assert.deepEqual(await setRole(other.id, owner.id, 'user'), { ok: true });
  });
});

describe('removing somebody', () => {
  it('takes their drives with them', async () => {
    const owner = await admin();
    const other = await findOrCreateByEmail('other@example.com');

    await createAccount({
      userId: other.id,
      provider: 'google_drive',
      catalogueKey: 'google_drive',
      nickname: 'theirs',
      remoteAccountId: 'theirs@example.com',
      tokens: { accessToken: 'a' },
    });

    assert.deepEqual(await removeUser(owner.id, other.id), { ok: true });
    assert.equal((await overview()).accounts, 0, 'their connections go with them');
  });

  it('refuses to remove yourself, or the last administrator', async () => {
    const owner = await admin();
    const other = await findOrCreateByEmail('other@example.com');

    assert.deepEqual(await removeUser(owner.id, owner.id), { ok: false, reason: 'self' });
    assert.deepEqual(await removeUser(other.id, owner.id), {
      ok: false,
      reason: 'last_admin',
    });
  });

  it('reports somebody who was never there', async () => {
    const owner = await admin();
    assert.deepEqual(await removeUser(owner.id, 'nobody'), { ok: false, reason: 'not_found' });
  });
});
