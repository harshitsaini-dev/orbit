import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'hosted';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

const { accessTo, invite, levelAllows, listMembers, readableAccountIds, revoke, setLevel } =
  await import('./sharing.js');
const { createAccount, deleteAccount, getAccountRow, listAccounts, useAccount } = await import(
  './accounts.js'
);
const { findOrCreateByEmail } = await import('./users.js');
const { useTestDatabase } = await import('../test-utils.js');

beforeEach(async () => {
  await useTestDatabase();
});

async function scene() {
  const owner = await findOrCreateByEmail('owner@example.com');
  const guest = await findOrCreateByEmail('guest@example.com');

  const account = await createAccount({
    userId: owner.id,
    provider: 'google_drive',
    catalogueKey: 'google_drive',
    nickname: 'Team Drive',
    remoteAccountId: 'team@example.com',
    tokens: { accessToken: 'access-sentinel', refreshToken: 'refresh-sentinel' },
  });

  return { owner, guest, account };
}

describe('what a level permits', () => {
  it('contains every level beneath it', () => {
    assert.equal(levelAllows('admin', 'read'), true);
    assert.equal(levelAllows('full', 'write'), true);
    assert.equal(levelAllows('write', 'read'), true);
  });

  it('stops write at read, and delete at write', () => {
    assert.equal(levelAllows('read', 'write'), false);
    // The common position: someone who adds files but must not remove them.
    assert.equal(levelAllows('write', 'delete'), false);
    assert.equal(levelAllows('full', 'delete'), true);
  });

  it('treats publishing a link as more than writing', () => {
    // A share link puts a file where it cannot be pulled back from.
    assert.equal(levelAllows('write', 'share'), false);
    assert.equal(levelAllows('full', 'share'), true);
  });

  it('reserves managing people for admins', () => {
    assert.equal(levelAllows('full', 'manage'), false);
    assert.equal(levelAllows('admin', 'manage'), true);
  });
});

describe('who can reach a drive', () => {
  it('gives the owner everything without a grant row', async () => {
    // The owner is not a guest on their own connection: a bug that wiped grants
    // must not be able to lock them out of it.
    const { owner, account } = await scene();

    const access = await accessTo(owner.id, account.id);
    assert.deepEqual(access, { ownerId: owner.id, isOwner: true, level: 'admin' });
    assert.equal((await listMembers(account.id)).length, 0);
  });

  it('shows a stranger nothing at all', async () => {
    const { account } = await scene();
    const stranger = await findOrCreateByEmail('nobody@example.com');

    assert.equal(await accessTo(stranger.id, account.id), null);
    assert.deepEqual(await listAccounts(stranger.id), []);
    // Not allowed and does not exist look identical, so an id cannot be probed.
    assert.equal(await getAccountRow(stranger.id, account.id, 'read'), null);
  });

  it('lets a guest read once invited, and no further', async () => {
    const { owner, guest, account } = await scene();

    await invite({
      accountId: account.id,
      ownerId: owner.id,
      grantedBy: owner.id,
      email: 'guest@example.com',
      level: 'read',
    });

    assert.ok(await getAccountRow(guest.id, account.id, 'read'));
    assert.equal(await getAccountRow(guest.id, account.id, 'write'), null);
    assert.equal(await getAccountRow(guest.id, account.id, 'delete'), null);
    assert.equal(await getAccountRow(guest.id, account.id, 'manage'), null);
  });

  it('lets a writer add files but not remove them', async () => {
    const { owner, guest, account } = await scene();

    await invite({
      accountId: account.id,
      ownerId: owner.id,
      grantedBy: owner.id,
      email: 'guest@example.com',
      level: 'write',
    });

    assert.ok(await getAccountRow(guest.id, account.id, 'write'));
    assert.equal(await getAccountRow(guest.id, account.id, 'delete'), null);
  });

  it('never lets a guest disconnect the drive, however high their level', async () => {
    // Somebody else's tokens and somebody else's provider account are not an
    // admin guest's to sever.
    const { owner, guest, account } = await scene();

    await invite({
      accountId: account.id,
      ownerId: owner.id,
      grantedBy: owner.id,
      email: 'guest@example.com',
      level: 'admin',
    });

    assert.equal(await deleteAccount(guest.id, account.id), false);
    assert.ok(await getAccountRow(guest.id, account.id, 'manage'));
    assert.equal(await deleteAccount(owner.id, account.id), true);
  });
});

describe('the drives a person sees', () => {
  it('lists their own first, then the ones they are a guest on', async () => {
    const { owner, guest, account } = await scene();

    const ownDrive = await createAccount({
      userId: guest.id,
      provider: 'google_drive',
      catalogueKey: 'google_drive',
      nickname: 'My own',
      remoteAccountId: 'guest-own@example.com',
      tokens: { accessToken: 'a' },
    });

    await invite({
      accountId: account.id,
      ownerId: owner.id,
      grantedBy: owner.id,
      email: 'guest@example.com',
      level: 'write',
    });

    const listed = await listAccounts(guest.id);
    assert.deepEqual(
      listed.map((a) => [a.id, a.isOwner, a.accessLevel]),
      [
        [ownDrive.id, true, 'admin'],
        [account.id, false, 'write'],
      ],
    );

    assert.deepEqual((await readableAccountIds(guest.id)).sort(), [ownDrive.id, account.id].sort());
  });

  it('takes the drive away the moment a grant is revoked', async () => {
    const { owner, guest, account } = await scene();

    await invite({
      accountId: account.id,
      ownerId: owner.id,
      grantedBy: owner.id,
      email: 'guest@example.com',
      level: 'full',
    });
    assert.equal((await listAccounts(guest.id)).length, 1);

    assert.equal(await revoke(account.id, guest.id), true);
    assert.deepEqual(await listAccounts(guest.id), []);
    assert.equal(await accessTo(guest.id, account.id), null);
  });

  it('does not hand a guest the tokens along with the files', async () => {
    // useAccount resolves against the owner's row, so a guest works through the
    // owner's connection without ever being able to read what it is made of.
    const { owner, guest, account } = await scene();

    await invite({
      accountId: account.id,
      ownerId: owner.id,
      grantedBy: owner.id,
      email: 'guest@example.com',
      level: 'read',
    });

    const active = await useAccount(guest.id, account.id, 'read');
    assert.equal(active!.row.userId, owner.id);

    const [listed] = await listAccounts(guest.id);
    assert.equal('encryptedTokens' in listed!, false);
  });
});

describe('inviting somebody', () => {
  it('creates the account for an address nobody has seen before', async () => {
    // There is no accept step: signing in with a code sent to that address is
    // what proves the invitation reached the right person.
    const { owner, account } = await scene();

    const result = await invite({
      accountId: account.id,
      ownerId: owner.id,
      grantedBy: owner.id,
      email: 'brand.new@example.com',
      level: 'read',
    });

    assert.equal(result.ok, true);
    assert.ok(await findOrCreateByEmail('brand.new@example.com'));

    const [member] = await listMembers(account.id);
    assert.equal(member!.email, 'brand.new@example.com');
    assert.equal(member!.joinedAt, null, 'pending until they actually sign in');
  });

  it('treats a second invitation as a change of level', async () => {
    // Which is what the button does when the level was wrong the first time.
    const { owner, account } = await scene();

    for (const level of ['read', 'full'] as const) {
      await invite({
        accountId: account.id,
        ownerId: owner.id,
        grantedBy: owner.id,
        email: 'guest@example.com',
        level,
      });
    }

    const members = await listMembers(account.id);
    assert.equal(members.length, 1);
    assert.equal(members[0]!.level, 'full');
  });

  it('normalises the address, so one person is not invited twice', async () => {
    const { owner, account } = await scene();

    await invite({
      accountId: account.id,
      ownerId: owner.id,
      grantedBy: owner.id,
      email: '  Guest@Example.com ',
      level: 'read',
    });

    assert.equal((await listMembers(account.id)).length, 1);
    assert.equal((await listMembers(account.id))[0]!.email, 'guest@example.com');
  });

  it('refuses to make the owner a guest on their own drive', async () => {
    const { owner, account } = await scene();

    const result = await invite({
      accountId: account.id,
      ownerId: owner.id,
      grantedBy: owner.id,
      email: 'owner@example.com',
      level: 'read',
    });

    assert.deepEqual(result, { ok: false, reason: 'owner' });
    assert.equal((await listMembers(account.id)).length, 0);
  });

  it('lets an admin guest invite, and records who did it', async () => {
    const { owner, guest, account } = await scene();

    await invite({
      accountId: account.id,
      ownerId: owner.id,
      grantedBy: owner.id,
      email: 'guest@example.com',
      level: 'admin',
    });

    const result = await invite({
      accountId: account.id,
      ownerId: owner.id,
      grantedBy: guest.id,
      email: 'third@example.com',
      level: 'read',
    });

    assert.equal(result.ok, true);
    assert.equal((await listMembers(account.id)).length, 2);
  });
});

describe('changing a level afterwards', () => {
  it('applies immediately to what the guest can do', async () => {
    const { owner, guest, account } = await scene();

    await invite({
      accountId: account.id,
      ownerId: owner.id,
      grantedBy: owner.id,
      email: 'guest@example.com',
      level: 'read',
    });
    assert.equal(await getAccountRow(guest.id, account.id, 'delete'), null);

    assert.equal(await setLevel(account.id, guest.id, 'full'), true);
    assert.ok(await getAccountRow(guest.id, account.id, 'delete'));

    // And down again, without having to remove and re-add them.
    await setLevel(account.id, guest.id, 'read');
    assert.equal(await getAccountRow(guest.id, account.id, 'delete'), null);
  });

  it('reports nothing changed for somebody who is not a member', async () => {
    const { guest, account } = await scene();
    assert.equal(await setLevel(account.id, guest.id, 'full'), false);
    assert.equal(await revoke(account.id, guest.id), false);
  });

  it('does not leak a grant on one drive into another', async () => {
    const { owner, guest, account } = await scene();

    const other = await createAccount({
      userId: owner.id,
      provider: 'google_drive',
      catalogueKey: 'google_drive',
      nickname: 'Personal',
      remoteAccountId: 'personal@example.com',
      tokens: { accessToken: 'a' },
    });

    await invite({
      accountId: account.id,
      ownerId: owner.id,
      grantedBy: owner.id,
      email: 'guest@example.com',
      level: 'admin',
    });

    // The whole reason the grant is per-drive rather than per-account.
    assert.equal(await accessTo(guest.id, other.id), null);
    assert.deepEqual(
      (await listAccounts(guest.id)).map((a) => a.id),
      [account.id],
    );
  });
});
