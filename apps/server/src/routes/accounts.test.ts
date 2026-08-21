import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_SECRET ??= 'test-session-secret';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.API_URL = 'http://localhost:8787';
process.env.APP_URL = 'http://localhost:5173';
process.env.API_RATE_LIMIT = '10000';

const { createApp } = await import('../app.js');
const { useTestDatabase } = await import('../test-utils.js');
const { createAccount } = await import('../services/accounts.js');
const { getLocalUser } = await import('../services/users.js');
const { decryptTokens } = await import('../lib/crypto.js');
const { db } = await import('../lib/db.js');
const { accounts } = await import('@orbit/db');

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

async function seedAccount(nickname = 'me@example.com') {
  const user = await getLocalUser();
  return createAccount({
    userId: user.id,
    provider: 'google_drive',
    catalogueKey: 'google_drive',
    nickname,
    tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000 },
  });
}

describe('GET /auth/connect/:provider', () => {
  it('redirects to Google with PKCE, offline access, and a state cookie', async () => {
    const res = await fetch(`${baseUrl}/auth/connect/google_drive`, { redirect: 'manual' });
    assert.equal(res.status, 302);

    const target = new URL(res.headers.get('location')!);
    assert.equal(target.origin + target.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(target.searchParams.get('client_id'), 'test-client-id');
    assert.equal(
      target.searchParams.get('redirect_uri'),
      'http://localhost:8787/auth/callback/google_drive',
    );
    assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(target.searchParams.get('code_challenge'));

    // Without these two Google issues no refresh token, so the account would
    // die in an hour with no way to renew it.
    assert.equal(target.searchParams.get('access_type'), 'offline');
    assert.equal(target.searchParams.get('prompt'), 'consent');

    assert.match(res.headers.get('set-cookie') ?? '', /orbit_oauth=/);
    assert.match(res.headers.get('set-cookie') ?? '', /HttpOnly/i);
  });

  it('never puts the client secret on the authorise URL', async () => {
    const res = await fetch(`${baseUrl}/auth/connect/google_drive`, { redirect: 'manual' });
    assert.ok(!res.headers.get('location')!.includes('test-client-secret'));
  });

  it('rejects a provider that does not use OAuth', async () => {
    const res = await fetch(`${baseUrl}/auth/connect/s3`, { redirect: 'manual' });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'unsupported_provider');
  });
});

describe('GET /auth/callback/:provider', () => {
  it('refuses a callback with no state cookie', async () => {
    const res = await fetch(`${baseUrl}/auth/callback/google_drive?code=abc&state=xyz`, {
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location')!, /connect=failed&reason=invalid_state/);
  });

  it('refuses a state that does not match the cookie', async () => {
    const begin = await fetch(`${baseUrl}/auth/connect/google_drive`, { redirect: 'manual' });
    const cookie = (begin.headers.get('set-cookie') ?? '').split(';')[0]!;

    const res = await fetch(`${baseUrl}/auth/callback/google_drive?code=abc&state=forged`, {
      headers: { cookie },
      redirect: 'manual',
    });
    assert.match(res.headers.get('location')!, /reason=invalid_state/);
  });

  it('reports a cancelled consent rather than failing silently', async () => {
    const res = await fetch(`${baseUrl}/auth/callback/google_drive?error=access_denied`, {
      redirect: 'manual',
    });
    assert.match(res.headers.get('location')!, /connect=failed&reason=access_denied/);
  });

  it('does not create an account when the state is invalid', async () => {
    await fetch(`${baseUrl}/auth/callback/google_drive?code=abc&state=xyz`, { redirect: 'manual' });
    const rows = await db().select().from(accounts);
    assert.equal(rows.length, 0);
  });
});

describe('GET /api/accounts', () => {
  it('lists connected accounts', async () => {
    await seedAccount();
    const res = await fetch(`${baseUrl}/api/accounts`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as { accounts: Array<{ nickname: string }> };
    assert.equal(body.accounts.length, 1);
    assert.equal(body.accounts[0]!.nickname, 'me@example.com');
  });

  it('never returns token material', async () => {
    await seedAccount();
    const raw = await (await fetch(`${baseUrl}/api/accounts`)).text();

    assert.ok(!raw.includes('encryptedTokens'), 'the ciphertext column must not be serialised');
    assert.ok(!raw.includes('accessToken'));
    assert.ok(!raw.includes('"rt"'));
  });

  it('stores tokens encrypted, not in the clear', async () => {
    await seedAccount();
    const [row] = await db().select().from(accounts);

    assert.ok(row);
    assert.ok(!row.encryptedTokens.includes('rt'), 'refresh token is readable in the column');
    assert.ok(!row.encryptedTokens.includes('at'));
    // And it round-trips.
    assert.equal(decryptTokens(row.encryptedTokens).refreshToken, 'rt');
  });
});

describe('DELETE /api/accounts/:id', () => {
  it('removes the account', async () => {
    const account = await seedAccount();
    const res = await fetch(`${baseUrl}/api/accounts/${account.id}`, { method: 'DELETE' });
    assert.equal(res.status, 204);

    assert.equal((await db().select().from(accounts)).length, 0);
  });

  it('404s for an id that is not there', async () => {
    const res = await fetch(`${baseUrl}/api/accounts/nope`, { method: 'DELETE' });
    assert.equal(res.status, 404);
  });
});

describe('GET /api/files', () => {
  it('requires an accountId', async () => {
    const res = await fetch(`${baseUrl}/api/files`);
    assert.equal(res.status, 400);
  });

  it('404s for an account that is not there', async () => {
    const res = await fetch(`${baseUrl}/api/files?accountId=nope`);
    assert.equal(res.status, 404);
  });
});
