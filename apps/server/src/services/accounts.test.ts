import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

const { createAccount, listAccounts, refreshExpiringAccounts, useAccount } = await import('./accounts.js');
const { getLocalUser } = await import('./users.js');
const { useTestDatabase } = await import('../test-utils.js');
const { getAdapter, ProviderError, isGrantRevoked } = await import('@orbit/adapters');
const { decryptTokens } = await import('../lib/crypto.js');
const { db } = await import('../lib/db.js');
const { accounts } = await import('@orbit/db');

const drive = getAdapter('google_drive');
const originalRefresh = drive.refreshToken.bind(drive);

function stubRefresh(fn: unknown): void {
  (drive as unknown as { refreshToken: unknown }).refreshToken = fn;
}

/** An access token this far from expiry is due a refresh. */
const EXPIRED = Date.now() - 1000;

async function seed(expiresAt: number) {
  const user = await getLocalUser();
  const account = await createAccount({
    userId: user.id,
    provider: 'google_drive',
    catalogueKey: 'google_drive',
    nickname: 'me@example.com',
    tokens: { accessToken: 'old', refreshToken: 'rt', expiresAt },
  });
  return { userId: user.id, accountId: account.id };
}

beforeEach(async () => {
  await useTestDatabase();
  stubRefresh(originalRefresh);
});

describe('isGrantRevoked', () => {
  it('treats an explicit refusal as a dead grant', () => {
    assert.equal(isGrantRevoked(new ProviderError('google_drive', 400, 'invalid_grant')), true);
    assert.equal(isGrantRevoked(new ProviderError('google_drive', 401, 'Unauthorized')), true);
    assert.equal(
      isGrantRevoked(new ProviderError('google_drive', 403, 'Token has been expired or revoked.')),
      true,
    );
  });

  it('does not treat a provider outage as a dead grant', () => {
    // This is the distinction that stops a blip forcing a reconnect.
    assert.equal(isGrantRevoked(new ProviderError('google_drive', 500, 'Internal error')), false);
    assert.equal(isGrantRevoked(new ProviderError('google_drive', 503, 'Backend unavailable')), false);
    assert.equal(isGrantRevoked(new ProviderError('google_drive', 0, 'ECONNRESET')), false);
    assert.equal(isGrantRevoked(new Error('socket hang up')), false);
  });
});

describe('useAccount', () => {
  it('refreshes an expiring token and persists the new one', async () => {
    stubRefresh(async () => ({ accessToken: 'fresh', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000 }));

    const { userId, accountId } = await seed(EXPIRED);
    const active = await useAccount(userId, accountId);

    assert.equal(active!.tokens.accessToken, 'fresh');

    const [row] = await db().select().from(accounts);
    assert.equal(decryptTokens(row!.encryptedTokens).accessToken, 'fresh', 'the refresh must be saved');
    assert.equal(row!.status, 'ok');
    assert.ok(row!.lastRefreshedAt);
  });

  it('leaves a healthy token alone', async () => {
    let called = false;
    stubRefresh(async () => {
      called = true;
      return {};
    });

    const { userId, accountId } = await seed(Date.now() + 3_600_000);
    await useAccount(userId, accountId);

    assert.equal(called, false, 'a valid token must not be refreshed for no reason');
  });

  it('does NOT demand a reconnect when the provider merely has a bad moment', async () => {
    // The whole point: a 503 or a reset connection must not cost the user their
    // connection. They would have to re-authorise an account that never broke.
    stubRefresh(async () => {
      throw new ProviderError('google_drive', 503, 'Backend Error');
    });

    const { userId, accountId } = await seed(EXPIRED);

    await assert.rejects(useAccount(userId, accountId), /provider_unavailable/);

    const [row] = await db().select().from(accounts);
    assert.notEqual(row!.status, 'needs_reauth', 'a transient failure must not kill the account');
    assert.equal(row!.status, 'error');

    // And it recovers on its own once the provider is back.
    stubRefresh(async () => ({ accessToken: 'fresh', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000 }));
    const active = await useAccount(userId, accountId);
    assert.equal(active!.tokens.accessToken, 'fresh');
    assert.equal((await db().select().from(accounts))[0]!.status, 'ok');
  });

  it('does demand a reconnect when the grant is actually gone', async () => {
    stubRefresh(async () => {
      throw new ProviderError('google_drive', 400, 'invalid_grant');
    });

    const { userId, accountId } = await seed(EXPIRED);
    await assert.rejects(useAccount(userId, accountId), /needs_reauth/);

    assert.equal((await db().select().from(accounts))[0]!.status, 'needs_reauth');
  });
});

describe('refreshExpiringAccounts', () => {
  it('renews a token well before it expires, so the user never waits on it', async () => {
    stubRefresh(async () => ({ accessToken: 'swept', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000 }));

    // Half an hour out: inside the sweep's margin, outside a request's.
    await seed(Date.now() + 30 * 60 * 1000);
    const result = await refreshExpiringAccounts();

    assert.equal(result.refreshed, 1);
    assert.equal(decryptTokens((await db().select().from(accounts))[0]!.encryptedTokens).accessToken, 'swept');
  });

  it('ignores a token that is nowhere near expiry', async () => {
    stubRefresh(async () => ({ accessToken: 'swept' }));

    await seed(Date.now() + 6 * 60 * 60 * 1000);
    assert.deepEqual(await refreshExpiringAccounts(), { refreshed: 0, revoked: 0, failed: 0 });
  });

  it('counts a provider outage as deferred, not as a revocation', async () => {
    stubRefresh(async () => {
      throw new ProviderError('google_drive', 500, 'Internal');
    });

    await seed(EXPIRED);
    const result = await refreshExpiringAccounts();

    assert.equal(result.failed, 1);
    assert.equal(result.revoked, 0);
    assert.notEqual((await db().select().from(accounts))[0]!.status, 'needs_reauth');
  });

  it('surfaces a dead grant before the user runs into it', async () => {
    stubRefresh(async () => {
      throw new ProviderError('google_drive', 400, 'invalid_grant');
    });

    const { userId } = await seed(EXPIRED);
    const result = await refreshExpiringAccounts();

    assert.equal(result.revoked, 1);
    assert.equal((await listAccounts(userId))[0]!.status, 'needs_reauth');
  });

  it('does not keep hammering an account already known to be dead', async () => {
    let calls = 0;
    stubRefresh(async () => {
      calls += 1;
      throw new ProviderError('google_drive', 400, 'invalid_grant');
    });

    await seed(EXPIRED);
    await refreshExpiringAccounts();
    await refreshExpiringAccounts();

    assert.equal(calls, 1, 'a needs_reauth account should be skipped on later sweeps');
  });
});
