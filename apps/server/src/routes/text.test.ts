import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_SECRET ??= 'test-session-secret';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.API_RATE_LIMIT = '10000';

const { createApp } = await import('../app.js');
const { useTestDatabase } = await import('../test-utils.js');
const { createAccount } = await import('../services/accounts.js');
const { getLocalUser } = await import('../services/users.js');

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

let accountId: string;

beforeEach(async () => {
  await useTestDatabase();
  const user = await getLocalUser();
  const account = await createAccount({
    userId: user.id,
    provider: 'google_drive',
    catalogueKey: 'google_drive',
    nickname: 'me@example.com',
    tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 },
  });
  accountId = account.id;
});

const RECEIPT =
  'NATIONAL MARKET PVT LTD\nGSTIN 09AABCU9603R1ZX\nInvoice 17842\nRose-e-Sharbat 2 x 145.00\nTotal 290.00';

async function store(overrides: Record<string, unknown> = {}) {
  return fetch(`${baseUrl}/api/text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accountId,
      remoteId: 'file-1',
      name: '1759653621497799480627.jpg',
      virtualPath: '/1759653621497799480627.jpg',
      text: RECEIPT,
      confidence: 82,
      ...overrides,
    }),
  });
}

describe('POST /api/text', () => {
  it('keeps a confident reading', async () => {
    const res = await store();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { stored: true });
  });

  it('declines a reading nobody could act on', async () => {
    // An unreadable photo produces confident-looking noise. Storing it means a
    // search that returns a file for a word that was never in it, which is
    // worse than a search that returns nothing.
    const res = await store({ text: 'l1 4~', confidence: 12 });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { stored: false });

    const found = await fetch(`${baseUrl}/api/text/search?q=l1`);
    assert.deepEqual(((await found.json()) as { matches: unknown[] }).matches, []);
  });

  it('replaces the previous reading rather than keeping both', async () => {
    await store();
    await store({ text: 'ANOTHER SHOP LTD\nInvoice 99', confidence: 90 });

    const res = await fetch(`${baseUrl}/api/text/search?q=Invoice`);
    const { matches } = (await res.json()) as { matches: Array<{ text: string }> };

    assert.equal(matches.length, 1);
    assert.match(matches[0]!.text, /ANOTHER SHOP/);
  });

  it('forgets a reading when the file stops being readable', async () => {
    await store();
    await store({ text: '', confidence: 0 });

    const res = await fetch(`${baseUrl}/api/text/search?q=NATIONAL`);
    assert.deepEqual(((await res.json()) as { matches: unknown[] }).matches, []);
  });

  it('refuses a drive the caller cannot read', async () => {
    const res = await store({ accountId: 'someone-elses-drive' });
    assert.deepEqual(await res.json(), { stored: false });
  });
});

describe('GET /api/text/search', () => {
  beforeEach(async () => {
    await store();
  });

  it('finds a photo by what is written in it', async () => {
    // The whole point: this file is called 1759653621497799480627.jpg, so no
    // provider's own search could ever find it.
    const res = await fetch(`${baseUrl}/api/text/search?q=Sharbat`);
    const { matches } = (await res.json()) as {
      matches: Array<{ name: string; excerpt: string; accountNickname: string }>;
    };

    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.name, '1759653621497799480627.jpg');
    assert.equal(matches[0]!.accountNickname, 'me@example.com');
    assert.match(matches[0]!.excerpt, /Sharbat/);
  });

  it('ignores case', async () => {
    const res = await fetch(`${baseUrl}/api/text/search?q=national%20market`);
    assert.equal(((await res.json()) as { matches: unknown[] }).matches.length, 1);
  });

  it('says nothing for a query too short to mean anything', async () => {
    const res = await fetch(`${baseUrl}/api/text/search?q=a`);
    assert.deepEqual(((await res.json()) as { matches: unknown[] }).matches, []);
  });

  it('treats a wildcard as a character, not as a pattern', async () => {
    // Unescaped, '%' matches everything and every scanned file comes back.
    const res = await fetch(`${baseUrl}/api/text/search?q=%25`);
    assert.deepEqual(((await res.json()) as { matches: unknown[] }).matches, []);
  });
});

describe('POST /api/text/known', () => {
  it('names the files already read, so a scan can skip them', async () => {
    await store();

    const res = await fetch(`${baseUrl}/api/text/known`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId, remoteIds: ['file-1', 'file-2'] }),
    });

    assert.deepEqual(await res.json(), { scanned: ['file-1'] });
  });
});

describe('DELETE /api/text/:accountId/:remoteId', () => {
  it('forgets one reading', async () => {
    await store();

    const gone = await fetch(`${baseUrl}/api/text/${accountId}/file-1`, { method: 'DELETE' });
    assert.equal(gone.status, 204);

    const res = await fetch(`${baseUrl}/api/text/search?q=Sharbat`);
    assert.deepEqual(((await res.json()) as { matches: unknown[] }).matches, []);
  });

  it('answers 404 for a reading that is not there', async () => {
    const res = await fetch(`${baseUrl}/api/text/${accountId}/nothing`, { method: 'DELETE' });
    assert.equal(res.status, 404);
  });
});
