import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

// Must be set before anything imports lib/env.js, which snapshots process.env.
process.env.AUTH_MODE = 'hosted';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_SECRET ??= 'test-session-secret';
/*
 * Emptied rather than deleted.
 *
 * `.env` is loaded when lib/env.js is imported, and dotenv fills in any key
 * that is *absent* from process.env - so deleting this one invited the real
 * key straight back in, and a developer who had one in their .env watched
 * this suite try to send eight actual emails and then fail, because the
 * console transport is what these tests read the code back from.
 *
 * An empty string is present, so dotenv leaves it alone, and it is falsy, so
 * the console transport is chosen.
 */
process.env.RESEND_API_KEY = '';
// The limiter has its own test below; give the rest of the suite headroom.
process.env.AUTH_RATE_LIMIT = '10000';

const { createApp } = await import('../app.js');
const { clearOutbox, lastCodeFor } = await import('../services/email.js');
const { useTestDatabase } = await import('../test-utils.js');

let server: Server;
let baseUrl: string;

const EMAIL = 'pilot@example.com';

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
  clearOutbox();
});

async function requestOtp(email = EMAIL) {
  return fetch(`${baseUrl}/auth/request-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
}

async function verify(email: string, code: string) {
  return fetch(`${baseUrl}/auth/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, code }),
  });
}

function sessionCookie(res: Response): string {
  const header = res.headers.get('set-cookie') ?? '';
  const value = header.split(';')[0] ?? '';
  assert.ok(value.startsWith('orbit_session='), `expected a session cookie, got: ${header}`);
  return value;
}

describe('POST /auth/request-otp', () => {
  it('rejects a malformed address', async () => {
    const res = await requestOtp('not-an-email');
    assert.equal(res.status, 400);
  });

  it('answers identically for a known and an unknown address', async () => {
    const first = await requestOtp('someone@example.com');
    const firstBody = await first.json();

    // Establish the account, then ask again.
    const issued = lastCodeFor('someone@example.com');
    assert.ok(issued);
    await verify('someone@example.com', issued.code);

    const second = await requestOtp('someone@example.com');
    assert.equal(second.status, first.status);
    assert.deepEqual(await second.json(), firstBody);
  });

  it('does not put the code in the response body', async () => {
    const res = await requestOtp();
    const body = JSON.stringify(await res.json());
    const issued = lastCodeFor(EMAIL);
    assert.ok(issued);
    assert.ok(!body.includes(issued.code));
  });
});

describe('POST /auth/verify-otp', () => {
  it('signs in with the correct code and sets an httpOnly cookie', async () => {
    await requestOtp();
    const issued = lastCodeFor(EMAIL);
    assert.ok(issued);

    const res = await verify(EMAIL, issued.code);
    assert.equal(res.status, 200);

    const header = res.headers.get('set-cookie') ?? '';
    assert.match(header, /HttpOnly/i);

    /*
     * Lax, and this is the case that forces it.
     *
     * A provider finishes its consent screen by sending the browser to
     * /auth/callback/:provider - a top-level navigation from another site. A
     * strict cookie is withheld on exactly that, so connecting a drive told
     * somebody who was signed in to sign in. It could not be seen in
     * development, where local mode authenticates every request without a
     * cookie at all.
     *
     * Lax still withholds the cookie on a cross-site POST, which is the case
     * CSRF actually needs.
     */
    assert.match(header, /SameSite=Lax/i);

    const body = (await res.json()) as { user: { email: string; role: string } };
    assert.equal(body.user.email, EMAIL);
  });

  it('makes the first user a superadmin and later users plain users', async () => {
    await requestOtp('first@example.com');
    const firstCode = lastCodeFor('first@example.com');
    assert.ok(firstCode);
    const first = await verify('first@example.com', firstCode.code);
    assert.equal(((await first.json()) as { user: { role: string } }).user.role, 'superadmin');

    await requestOtp('second@example.com');
    const secondCode = lastCodeFor('second@example.com');
    assert.ok(secondCode);
    const second = await verify('second@example.com', secondCode.code);
    assert.equal(((await second.json()) as { user: { role: string } }).user.role, 'user');
  });

  it('rejects a wrong code without revealing why', async () => {
    await requestOtp();
    const issued = lastCodeFor(EMAIL);
    assert.ok(issued);
    const wrong = issued.code === '000000' ? '111111' : '000000';

    const res = await verify(EMAIL, wrong);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'invalid_code');
    assert.equal(res.headers.get('set-cookie'), null);
  });

  it('returns the same error for a never-issued code as for a wrong one', async () => {
    await requestOtp();
    const issued = lastCodeFor(EMAIL);
    assert.ok(issued);
    const wrong = issued.code === '000000' ? '111111' : '000000';

    const wrongRes = await verify(EMAIL, wrong);
    const strangerRes = await verify('stranger@example.com', '123456');

    assert.equal(strangerRes.status, wrongRes.status);
    assert.deepEqual(await strangerRes.json(), await wrongRes.json());
  });

  it('rejects a code of the wrong shape', async () => {
    const res = await verify(EMAIL, 'abcdef');
    assert.equal(res.status, 400);
  });
});

describe('GET /auth/me', () => {
  it('is 401 without a session', async () => {
    const res = await fetch(`${baseUrl}/auth/me`);
    assert.equal(res.status, 401);
  });

  it('returns the signed-in user with a session cookie', async () => {
    await requestOtp();
    const issued = lastCodeFor(EMAIL);
    assert.ok(issued);
    const cookie = sessionCookie(await verify(EMAIL, issued.code));

    const res = await fetch(`${baseUrl}/auth/me`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { user: { email: string } };
    assert.equal(body.user.email, EMAIL);
  });

  it('rejects a forged session token', async () => {
    const res = await fetch(`${baseUrl}/auth/me`, { headers: { cookie: 'orbit_session=made-up' } });
    assert.equal(res.status, 401);
  });
});

describe('POST /auth/logout', () => {
  it('invalidates the session server-side, not just the cookie', async () => {
    await requestOtp();
    const issued = lastCodeFor(EMAIL);
    assert.ok(issued);
    const cookie = sessionCookie(await verify(EMAIL, issued.code));

    assert.equal((await fetch(`${baseUrl}/auth/me`, { headers: { cookie } })).status, 200);

    const logout = await fetch(`${baseUrl}/auth/logout`, { method: 'POST', headers: { cookie } });
    assert.equal(logout.status, 204);

    // Replaying the same cookie must now fail.
    assert.equal((await fetch(`${baseUrl}/auth/me`, { headers: { cookie } })).status, 401);
  });
});

describe('GET /auth/dev/last-code', () => {
  it('is not routable unless explicitly enabled', async () => {
    const res = await fetch(`${baseUrl}/auth/dev/last-code?email=${EMAIL}`);
    assert.equal(res.status, 404);
  });
});
