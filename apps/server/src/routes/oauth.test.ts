import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_SECRET ??= 'test-session-secret';
process.env.API_RATE_LIMIT = '10000';
process.env.APP_URL = 'http://localhost:5173';

const { createApp } = await import('../app.js');
const { useTestDatabase } = await import('../test-utils.js');
const { isUsableRedirect } = await import('../services/oauth-apps.js');

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

const REDIRECT = 'https://app.example.com/callback';

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function register(overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/api/oauth/apps`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Receipts',
      redirectUris: [REDIRECT],
      scopes: ['files:read', 'files:download'],
      confidential: true,
      ...overrides,
    }),
  });

  return res;
}

async function registered(overrides: Record<string, unknown> = {}) {
  const res = await register(overrides);
  return (await res.json()) as {
    app: { id: string; clientId: string; scopes: string[] };
    secret: string | null;
  };
}

/** The whole flow, as a client would walk it. */
async function authorise(
  clientId: string,
  challenge: string,
  scope = 'files:read files:download',
) {
  const consent = await fetch(`${baseUrl}/api/oauth/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope,
      code_challenge: challenge,
      state: 'xyz',
    }),
  });

  const { redirectTo } = (await consent.json()) as { redirectTo: string };
  return new URL(redirectTo).searchParams.get('code')!;
}

async function token(form: Record<string, string>) {
  return fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
}

describe('where an authorisation may be sent', () => {
  const allowed = [
    'https://app.example.com/callback',
    // How a desktop or CLI app receives a code: it listens on a loopback port
    // and there is no network for anyone to be on the path of.
    'http://127.0.0.1:7777/callback',
    'http://localhost:7777/callback',
    'myapp://auth',
  ];

  const refused = [
    ['plain http to somewhere real', 'http://app.example.com/callback'],
    ['a fragment, which the browser drops before the request', 'https://app.example.com/cb#x'],
    ['javascript', 'javascript:alert(1)'],
    ['not a URL', 'callback'],
  ] as const;

  for (const uri of allowed) {
    it(`allows ${uri}`, () => assert.equal(isUsableRedirect(uri), true));
  }

  for (const [what, uri] of refused) {
    it(`refuses ${what}`, () => assert.equal(isUsableRedirect(uri), false));
  }

  it('refuses one through the API before the app is stored', async () => {
    const res = await register({ redirectUris: ['http://app.example.com/cb'] });
    assert.equal(res.status, 400);

    const list = await fetch(`${baseUrl}/api/oauth/apps`);
    assert.deepEqual(((await list.json()) as { apps: unknown[] }).apps, []);
  });
});

describe('GET /oauth/authorize', () => {
  it('hands the browser to the consent screen once the request checks out', async () => {
    const { app } = await registered();
    const { challenge } = pkce();

    const query = new URLSearchParams({
      response_type: 'code',
      client_id: app.clientId,
      redirect_uri: REDIRECT,
      scope: 'files:read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
    });

    const res = await fetch(`${baseUrl}/oauth/authorize?${query}`, { redirect: 'manual' });

    assert.equal(res.status, 302);
    const to = new URL(res.headers.get('location')!);
    assert.equal(to.origin + to.pathname, 'http://localhost:5173/authorize');
    assert.equal(to.searchParams.get('scope'), 'files:read');
    assert.equal(to.searchParams.get('state'), 'xyz');
  });

  it('refuses an unregistered redirect rather than redirecting to it', async () => {
    const { app } = await registered();
    const { challenge } = pkce();

    const query = new URLSearchParams({
      response_type: 'code',
      client_id: app.clientId,
      redirect_uri: 'https://attacker.test/steal',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    const res = await fetch(`${baseUrl}/oauth/authorize?${query}`, { redirect: 'manual' });

    // Sending the error to the address in the request is how an open redirect
    // gets built out of an authorisation server.
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('location'), null);
  });

  it('refuses a redirect that only looks registered', async () => {
    const { app } = await registered();
    const { challenge } = pkce();

    const query = new URLSearchParams({
      response_type: 'code',
      client_id: app.clientId,
      // A prefix match would accept this.
      redirect_uri: `${REDIRECT}.attacker.test/`,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    assert.equal((await fetch(`${baseUrl}/oauth/authorize?${query}`)).status, 400);
  });

  it('insists on PKCE with S256', async () => {
    const { app } = await registered();

    const withoutPkce = new URLSearchParams({
      response_type: 'code',
      client_id: app.clientId,
      redirect_uri: REDIRECT,
    });
    assert.equal((await fetch(`${baseUrl}/oauth/authorize?${withoutPkce}`)).status, 400);

    const plain = new URLSearchParams({
      response_type: 'code',
      client_id: app.clientId,
      redirect_uri: REDIRECT,
      code_challenge: pkce().challenge,
      // `plain` sends the verifier itself on the leg being protected.
      code_challenge_method: 'plain',
    });
    assert.equal((await fetch(`${baseUrl}/oauth/authorize?${plain}`)).status, 400);
  });

  it('will not grant more than the application registered for', async () => {
    const { app } = await registered({ scopes: ['files:read'] });
    const { challenge } = pkce();

    const query = new URLSearchParams({
      response_type: 'code',
      client_id: app.clientId,
      redirect_uri: REDIRECT,
      scope: 'files:read files:delete accounts:write',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    const res = await fetch(`${baseUrl}/oauth/authorize?${query}`, { redirect: 'manual' });
    const to = new URL(res.headers.get('location')!);

    assert.equal(to.searchParams.get('scope'), 'files:read');
  });
});

describe('POST /oauth/token', () => {
  it('exchanges a code for tokens that work on /v1', async () => {
    const { app, secret } = await registered({
      scopes: ['files:read', 'files:download', 'accounts:read'],
    });
    const { verifier, challenge } = pkce();
    const code = await authorise(
      app.clientId,
      challenge,
      'files:read files:download accounts:read',
    );

    const res = await token({
      grant_type: 'authorization_code',
      code,
      client_id: app.clientId,
      client_secret: secret!,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });

    assert.equal(res.status, 200);
    // A response that is a credential is never cached, anywhere.
    assert.match(res.headers.get('cache-control') ?? '', /no-store/);

    const tokens = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      scope: string;
    };

    assert.match(tokens.access_token, /^orbit_at_/);
    assert.match(tokens.refresh_token, /^orbit_rt_/);
    assert.equal(tokens.token_type, 'Bearer');
    assert.equal(tokens.scope, 'files:read files:download accounts:read');

    // The point of all of it: the token acts on /v1 as the person who allowed it.
    const used = await fetch(`${baseUrl}/v1/accounts`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    assert.equal(used.status, 200);
  });

  it('carries only the scopes that were agreed to', async () => {
    // The consent screen said files, so an application reaching for accounts
    // is refused - by the same scope check a personal token goes through.
    const { app, secret } = await registered({ scopes: ['files:read'] });
    const { verifier, challenge } = pkce();
    const code = await authorise(app.clientId, challenge, 'files:read');

    const issued = await token({
      grant_type: 'authorization_code',
      code,
      client_id: app.clientId,
      client_secret: secret!,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });

    const { access_token } = (await issued.json()) as { access_token: string };

    const refused = await fetch(`${baseUrl}/v1/accounts`, {
      headers: { authorization: `Bearer ${access_token}` },
    });

    assert.equal(refused.status, 403);
  });

  it('refuses the wrong verifier', async () => {
    const { app, secret } = await registered();
    const { challenge } = pkce();
    const code = await authorise(app.clientId, challenge);

    const res = await token({
      grant_type: 'authorization_code',
      code,
      client_id: app.clientId,
      client_secret: secret!,
      redirect_uri: REDIRECT,
      code_verifier: pkce().verifier,
    });

    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_grant');
  });

  it('refuses a redirect that is not the one the code was issued for', async () => {
    const { app, secret } = await registered({
      redirectUris: [REDIRECT, 'https://app.example.com/other'],
    });
    const { verifier, challenge } = pkce();
    const code = await authorise(app.clientId, challenge);

    const res = await token({
      grant_type: 'authorization_code',
      code,
      client_id: app.clientId,
      client_secret: secret!,
      redirect_uri: 'https://app.example.com/other',
      code_verifier: verifier,
    });

    assert.equal(res.status, 400);
  });

  it('refuses the wrong client secret', async () => {
    const { app } = await registered();
    const { verifier, challenge } = pkce();
    const code = await authorise(app.clientId, challenge);

    const res = await token({
      grant_type: 'authorization_code',
      code,
      client_id: app.clientId,
      client_secret: 'orbit_secret_wrong',
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });

    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_client');
  });

  it('burns a code, and revokes what it granted if it is used twice', async () => {
    const { app, secret } = await registered();
    const { verifier, challenge } = pkce();
    const code = await authorise(app.clientId, challenge);

    const first = await token({
      grant_type: 'authorization_code',
      code,
      client_id: app.clientId,
      client_secret: secret!,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });

    const { access_token } = (await first.json()) as { access_token: string };

    const second = await token({
      grant_type: 'authorization_code',
      code,
      client_id: app.clientId,
      client_secret: secret!,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });

    assert.equal(second.status, 400);

    /*
     * A code redeemed twice means somebody else has it, so what the first
     * redemption produced cannot be trusted either. The token from the
     * *successful* exchange stops working.
     */
    const used = await fetch(`${baseUrl}/v1/accounts`, {
      headers: { authorization: `Bearer ${access_token}` },
    });
    assert.equal(used.status, 401);
  });

  it('rotates the refresh token every time it is used', async () => {
    const { app, secret } = await registered();
    const { verifier, challenge } = pkce();
    const code = await authorise(app.clientId, challenge);

    const first = await token({
      grant_type: 'authorization_code',
      code,
      client_id: app.clientId,
      client_secret: secret!,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    const one = (await first.json()) as { refresh_token: string };

    const second = await token({
      grant_type: 'refresh_token',
      refresh_token: one.refresh_token,
      client_id: app.clientId,
      client_secret: secret!,
    });
    const two = (await second.json()) as { refresh_token: string; access_token: string };

    assert.notEqual(one.refresh_token, two.refresh_token);

    // A refresh token that never changed would be one a copy of stays valid
    // for ever.
    const reused = await token({
      grant_type: 'refresh_token',
      refresh_token: one.refresh_token,
      client_id: app.clientId,
      client_secret: secret!,
    });
    assert.equal(reused.status, 400);
  });

  it('refuses a grant type that was removed from the specification', async () => {
    const res = await token({ grant_type: 'password', username: 'a', password: 'b' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'unsupported_grant_type');
  });
});

describe('taking access back', () => {
  it('lists what was allowed and stops it working', async () => {
    const { app, secret } = await registered();
    const { verifier, challenge } = pkce();
    const code = await authorise(app.clientId, challenge);

    const issued = await token({
      grant_type: 'authorization_code',
      code,
      client_id: app.clientId,
      client_secret: secret!,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    const { access_token } = (await issued.json()) as { access_token: string };

    const listed = await fetch(`${baseUrl}/api/oauth/allowed`);
    const { apps } = (await listed.json()) as { apps: Array<{ appId: string; name: string }> };

    assert.equal(apps.length, 1);
    assert.equal(apps[0]!.name, 'Receipts');

    const revoked = await fetch(`${baseUrl}/api/oauth/allowed/${apps[0]!.appId}`, {
      method: 'DELETE',
    });
    assert.equal(revoked.status, 204);

    const after = await fetch(`${baseUrl}/v1/accounts`, {
      headers: { authorization: `Bearer ${access_token}` },
    });
    assert.equal(after.status, 401);
  });
});

describe('a public client', () => {
  it('needs no secret, and PKCE is what proves it', async () => {
    const { app, secret } = await registered({ confidential: false });
    assert.equal(secret, null);

    const { verifier, challenge } = pkce();
    const code = await authorise(app.clientId, challenge);

    const res = await token({
      grant_type: 'authorization_code',
      code,
      client_id: app.clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });

    assert.equal(res.status, 200);
  });
});
