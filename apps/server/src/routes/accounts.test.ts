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
const { hostLabel, resolveEndpoint } = await import('./accounts.js');

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

/**
 * Long enough not to appear in ciphertext by accident.
 *
 * These were 'at' and 'rt'. A two-character string turns up somewhere in a
 * random base64 blob about six times in a hundred, so the encryption test
 * failed roughly one run in seventeen - and looked like a flake rather than
 * what it was, a test that could not tell a leak from a coincidence.
 */
const ACCESS_TOKEN = 'access-token-sentinel-8f3a2c';
const SECRET_KEY = 'secret-access-key-sentinel-2d90fa';
const REFRESH_TOKEN = 'refresh-token-sentinel-b71e04';

async function seedAccount(nickname = 'me@example.com') {
  const user = await getLocalUser();
  return createAccount({
    userId: user.id,
    provider: 'google_drive',
    catalogueKey: 'google_drive',
    nickname,
    tokens: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN, expiresAt: Date.now() + 3_600_000 },
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
    assert.ok(!raw.includes(REFRESH_TOKEN));
  });

  it('stores tokens encrypted, not in the clear', async () => {
    await seedAccount();
    const [row] = await db().select().from(accounts);

    assert.ok(row);
    assert.ok(
      !row.encryptedTokens.includes(REFRESH_TOKEN),
      'refresh token is readable in the column',
    );
    assert.ok(!row.encryptedTokens.includes(ACCESS_TOKEN));
    // And it round-trips.
    assert.equal(decryptTokens(row.encryptedTokens).refreshToken, REFRESH_TOKEN);
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

describe('POST /api/accounts/connect', () => {
  const realFetch = globalThis.fetch;
  let outbound: URL[] = [];

  /** Stands in for the bucket: answers the listing the adapter probes with. */
  function stubStore(status = 200) {
    outbound = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      // `RequestInfo` is a string or a Request; String() on the latter gives
      // "[object Request]" and the URL constructor then throws.
      const url =
        input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.host.startsWith('127.0.0.1') || url.host.startsWith('localhost')) {
        return realFetch(input, init);
      }
      outbound.push(url);
      return new Response(
        status === 200
          ? '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>'
          : '<Error><Code>AccessDenied</Code><Message>no</Message></Error>',
        { status },
      );
    });
  }

  function restore() {
    globalThis.fetch = realFetch;
  }

  const values = {
    accountId: 'acct123',
    // 32 hex characters, which is the shape R2 actually issues - the connect
    // route refuses anything else before it reaches the network.
    accessKeyId: 'fcab9d45a289252eb22621053c0d1e2f',
    secretAccessKey: SECRET_KEY,
    bucket: 'photos',
  };

  it('builds the endpoint from the catalogue template', async () => {
    stubStore();
    try {
      const res = await fetch(`${baseUrl}/api/accounts/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ catalogueKey: 'cloudflare_r2', values }),
      });

      assert.equal(res.status, 201);
      const body = (await res.json()) as { account: { nickname: string; catalogueKey: string } };
      assert.equal(body.account.nickname, 'photos');
      // The catalogue key is kept, not the adapter id: R2 and Backblaze both run
      // on the s3 adapter but must not show up as the same thing.
      assert.equal(body.account.catalogueKey, 'cloudflare_r2');

      // R2 needs path-style addressing, so the bucket belongs in the path.
      assert.equal(outbound[0]!.host, 'acct123.r2.cloudflarestorage.com');
      assert.equal(outbound[0]!.pathname, '/photos');
    } finally {
      restore();
    }
  });

  it('stores the keys encrypted, never in the response', async () => {
    stubStore();
    try {
      const res = await fetch(`${baseUrl}/api/accounts/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ catalogueKey: 'cloudflare_r2', values }),
      });

      const text = JSON.stringify(await res.json());
      assert.ok(!text.includes(SECRET_KEY), 'the secret must not travel back to the browser');

      const [row] = await db().select().from(accounts);
      assert.ok(!row!.encryptedTokens.includes(SECRET_KEY));
      assert.equal(decryptTokens(row!.encryptedTokens).secretAccessKey, SECRET_KEY);
    } finally {
      restore();
    }
  });

  it('rejects keys the store refuses, as the user error it is', async () => {
    stubStore(403);
    try {
      const res = await fetch(`${baseUrl}/api/accounts/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ catalogueKey: 'cloudflare_r2', values }),
      });

      // Not a 500: a mistyped key is the user's to fix, and nothing broke here.
      assert.equal(res.status, 400);
      assert.equal((await db().select().from(accounts)).length, 0);
    } finally {
      restore();
    }
  });

  it('names the fields that were left empty', async () => {
    const res = await fetch(`${baseUrl}/api/accounts/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        catalogueKey: 'cloudflare_r2',
        values: { accessKeyId: 'fcab9d45a289252eb22621053c0d1e2f' },
      }),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /Cloudflare account ID/);
    assert.match(body.error.message, /Bucket name/);
  });

  it('refuses a provider that connects by OAuth', async () => {
    const res = await fetch(`${baseUrl}/api/accounts/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catalogueKey: 'google_drive', values }),
    });

    assert.equal(res.status, 400);
  });

  it('refuses a catalogue entry with no adapter behind it', async () => {
    // Listed on the landing page as intended, but connecting would dead-end.
    const res = await fetch(`${baseUrl}/api/accounts/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catalogueKey: 'azure_blob', values }),
    });

    assert.equal(res.status, 404);
  });

  it('re-entering the same bucket refreshes the connection instead of duplicating it', async () => {
    stubStore();
    try {
      for (let i = 0; i < 2; i += 1) {
        await fetch(`${baseUrl}/api/accounts/connect`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ catalogueKey: 'cloudflare_r2', values }),
        });
      }

      assert.equal((await db().select().from(accounts)).length, 1);
    } finally {
      restore();
    }
  });
});

describe('building an endpoint from what someone pasted', () => {
  it('accepts the whole S3 endpoint, which is what the provider shows you', async () => {
    // Supabase's settings page shows the full URL, so pasting it into a field
    // called "project reference" is the obvious move rather than a mistake.
    // Left alone it produced https://https://ref.storage.supabase.co/... and
    // failed at DNS with "fetch failed", which points at nothing.
    assert.equal(
      resolveEndpoint('https://{projectRef}.storage.supabase.co/storage/v1/s3', {
        projectRef: 'https://fzvmqnupiqvlocwdvyxy.storage.supabase.co/storage/v1/s3',
      }),
      'https://fzvmqnupiqvlocwdvyxy.storage.supabase.co/storage/v1/s3',
    );
  });

  it('accepts the bare reference too', async () => {
    assert.equal(
      resolveEndpoint('https://{projectRef}.storage.supabase.co/storage/v1/s3', {
        projectRef: 'fzvmqnupiqvlocwdvyxy',
      }),
      'https://fzvmqnupiqvlocwdvyxy.storage.supabase.co/storage/v1/s3',
    );
  });

  it('accepts a project URL, which is the other thing to hand', async () => {
    assert.equal(
      resolveEndpoint('https://{projectRef}.storage.supabase.co/storage/v1/s3', {
        projectRef: 'https://fzvmqnupiqvlocwdvyxy.supabase.co',
      }),
      'https://fzvmqnupiqvlocwdvyxy.storage.supabase.co/storage/v1/s3',
    );
  });

  it('leaves a value that is not a hostname alone', async () => {
    // A region or an account id must survive untouched.
    assert.equal(hostLabel('ap-south-1'), 'ap-south-1');
    assert.equal(hostLabel('acct123'), 'acct123');
  });

  it('fills a Cloudflare account id the same way', async () => {
    assert.equal(
      resolveEndpoint('https://{accountId}.r2.cloudflarestorage.com', { accountId: 'acct123' }),
      'https://acct123.r2.cloudflarestorage.com',
    );
  });
});

describe('catching a pasted value that cannot work', () => {
  it('recognises an R2 API token in the access key field', async () => {
    // R2 shows the token, the access key and the secret together, so pasting
    // the wrong one is a slip - and Cloudflare answers it with "length 53,
    // should be 32", which names a length rather than a field.
    const res = await fetch(`${baseUrl}/api/accounts/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        catalogueKey: 'cloudflare_r2',
        values: {
          accountId: '41cb48f3cd244cd4fe1f1f64c5e88332',
          accessKeyId: 'cfat_NabOmBzrPyuZmnkB63KL2oJ4JBeubZGYpu',
          secretAccessKey: 'whatever',
          bucket: 'portfolio-media',
        },
      }),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /API token/);
    assert.match(body.error.message, /32-character/);
  });

  it('accepts a real R2 access key id', async () => {
    // 32 hex characters, which is what R2 issues.
    const res = await fetch(`${baseUrl}/api/accounts/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        catalogueKey: 'cloudflare_r2',
        values: {
          accountId: '41cb48f3cd244cd4fe1f1f64c5e88332',
          accessKeyId: 'fcab9d45a289252eb22621053c0d1e2f',
          secretAccessKey: 'whatever',
          bucket: 'portfolio-media',
        },
      }),
    });

    // It gets as far as the network - a refusal from there reads differently
    // from a refusal here, which is all this test claims.
    const body = (await res.json()) as { error: { message: string } };
    assert.doesNotMatch(body.error.message, /API token|32-character/);
  });

  it('recognises a Supabase project key in the access key field', async () => {
    const res = await fetch(`${baseUrl}/api/accounts/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        catalogueKey: 'supabase_storage',
        values: {
          projectRef: 'abcdef',
          region: 'ap-south-1',
          accessKeyId: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
          secretAccessKey: 'whatever',
          bucket: 'test',
        },
      }),
    });

    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: { message: string } }).error.message, /S3 access key/);
  });
});
