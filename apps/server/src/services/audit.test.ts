import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'hosted';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

const { listForAccount, listForActor, record } = await import('./audit.js');
const { createAccount, deleteAccount } = await import('./accounts.js');
const { findOrCreateByEmail } = await import('./users.js');
const { useTestDatabase } = await import('../test-utils.js');
const { db } = await import('../lib/db.js');
const { users } = await import('@orbit/db');
const { eq } = await import('drizzle-orm');

beforeEach(useTestDatabase);

async function scene() {
  const owner = await findOrCreateByEmail('owner@example.com');
  const guest = await findOrCreateByEmail('guest@example.com');

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

describe('recording what happened', () => {
  it('reads back newest first, which is the order anyone wants', async () => {
    const { owner, account } = await scene();

    for (const summary of ['first', 'second', 'third']) {
      await record({
        actorId: owner.id,
        actorEmail: owner.email,
        action: 'file.delete',
        accountId: account.id,
        summary,
      });
    }

    const entries = await listForAccount(account.id);
    assert.equal(entries[0]!.summary, 'third');
    assert.equal(entries.length, 3);
  });

  it('keeps one drive\'s history out of another\'s', async () => {
    const { owner, account } = await scene();
    const other = await createAccount({
      userId: owner.id,
      provider: 'google_drive',
      catalogueKey: 'google_drive',
      nickname: 'Personal',
      remoteAccountId: 'personal@example.com',
      tokens: { accessToken: 'a' },
    });

    await record({ actorId: owner.id, action: 'file.delete', accountId: account.id });

    assert.equal((await listForAccount(account.id)).length, 1);
    assert.deepEqual(await listForAccount(other.id), []);
  });

  it('names who did it, whether the owner or a guest', async () => {
    const { owner, guest, account } = await scene();

    await record({
      actorId: guest.id,
      actorEmail: guest.email,
      action: 'file.delete',
      accountId: account.id,
      summary: 'Deleted 3 items',
    });

    const [entry] = await listForAccount(account.id);
    assert.equal(entry!.actorEmail, 'guest@example.com');
    assert.notEqual(entry!.actorId, owner.id);
  });

  it('survives the person being removed, with the name gone', async () => {
    // A trail that deletes itself along with the person it is about is not a
    // trail. The entry stays, saying what happened.
    const { guest, account } = await scene();

    await record({
      actorId: guest.id,
      actorEmail: guest.email,
      action: 'file.delete',
      accountId: account.id,
      summary: 'Deleted 3 items',
    });

    await db().delete(users).where(eq(users.id, guest.id));

    const [entry] = await listForAccount(account.id);
    assert.ok(entry, 'the entry outlives the actor');
    assert.equal(entry.actorId, null);
    assert.equal(entry.summary, 'Deleted 3 items');
    // The address recorded at the time is still there to say who it was.
    assert.equal(entry.actorEmail, 'guest@example.com');
  });

  it('shows the current address for somebody who changed theirs', async () => {
    // One person should read as one person throughout, not as two.
    const { guest, account } = await scene();

    await record({
      actorId: guest.id,
      actorEmail: 'old@example.com',
      action: 'file.delete',
      accountId: account.id,
    });

    await db().update(users).set({ email: 'new@example.com' }).where(eq(users.id, guest.id));

    assert.equal((await listForAccount(account.id))[0]!.actorEmail, 'new@example.com');
  });

  it('goes away with the drive it was about', async () => {
    // The alternative is rows pointing at a connection nobody can open, which
    // nothing would ever show.
    const { owner, account } = await scene();

    await record({ actorId: owner.id, action: 'file.delete', accountId: account.id });
    await deleteAccount(owner.id, account.id);

    assert.deepEqual(await listForAccount(account.id), []);
  });

  it('keeps an entry that names no drive on the actor\'s own trail', async () => {
    // Disconnecting is the case: an entry naming the account that has just gone
    // would delete itself in the same breath.
    const { owner } = await scene();

    await record({
      actorId: owner.id,
      actorEmail: owner.email,
      action: 'account.disconnect',
      summary: 'Disconnected a drive',
    });

    const mine = await listForActor(owner.id);
    assert.equal(mine.some((entry) => entry.action === 'account.disconnect'), true);
  });

  it('never lets a failed write break the thing being logged', async () => {
    // Somebody deleting a file must not be told the delete failed because a row
    // could not be inserted.
    await assert.doesNotReject(
      record({ actorId: 'nobody-at-all', action: 'file.delete', accountId: 'nor-this' }),
    );
  });

  it('truncates rather than losing an entry with a very long summary', async () => {
    const { owner, account } = await scene();

    await record({
      actorId: owner.id,
      action: 'file.delete',
      accountId: account.id,
      summary: 'x'.repeat(5_000),
    });

    const [entry] = await listForAccount(account.id);
    assert.equal(entry!.summary!.length, 500);
  });
});
