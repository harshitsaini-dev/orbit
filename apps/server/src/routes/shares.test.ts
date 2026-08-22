import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_SECRET ??= 'test-session-secret';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.API_RATE_LIMIT = '10000';
process.env.SHARE_RATE_LIMIT = '10000';

const { createApp } = await import('../app.js');
const { useTestDatabase } = await import('../test-utils.js');
const { createAccount } = await import('../services/accounts.js');
const { getLocalUser } = await import('../services/users.js');
const { getAdapter } = await import('@orbit/adapters');

const drive = getAdapter('google_drive');
const pristine = {
  getFileMeta: drive.getFileMeta.bind(drive),
  getFileStream: drive.getFileStream.bind(drive),
};

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
  (drive as unknown as Record<string, unknown>).getFileMeta = pristine.getFileMeta;
  (drive as unknown as Record<string, unknown>).getFileStream = pristine.getFileStream;
});

function stubFile(overrides: Record<string, unknown> = {}): void {
  (drive as unknown as Record<string, unknown>).getFileMeta = async () => ({
    remoteId: 'file-1',
    name: 'beach.jpg',
    virtualPath: '/Photos/beach.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 2048,
    isFolder: false,
    starred: false,
    modifiedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  });

  (drive as unknown as Record<string, unknown>).getFileStream = async () => ({
    stream: new Blob(['image-bytes']).stream(),
    contentType: 'image/jpeg',
    contentLength: 11,
  });
}

async function seedAccount() {
  const user = await getLocalUser();
  return createAccount({
    userId: user.id,
    provider: 'google_drive',
    catalogueKey: 'google_drive',
    nickname: 'me@example.com',
    tokens: {
      accessToken: 'access-token-sentinel',
      refreshToken: 'refresh-token-sentinel',
      expiresAt: Date.now() + 3_600_000,
    },
  });
}

async function makeShare(body: Record<string, unknown> = {}) {
  stubFile();
  const account = await seedAccount();

  const res = await fetch(`${baseUrl}/api/shares`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: account.id, remoteId: 'file-1', ...body }),
  });

  return { res, account };
}

describe('POST /api/shares', () => {
  it('creates a link with a snapshot of the file', async () => {
    const { res } = await makeShare();
    assert.equal(res.status, 201);

    const { share } = (await res.json()) as { share: Record<string, unknown> };
    assert.equal(share['name'], 'beach.jpg');
    assert.equal(share['sizeBytes'], 2048);
    assert.match(String(share['url']), /\/s\/[a-z2-9]{12}$/);
  });

  it('uses an alphabet with no lookalike characters', async () => {
    // These get read aloud and typed from a QR that would not scan, so 0/O and
    // 1/l/I are excluded.
    const { res } = await makeShare();
    const { share } = (await res.json()) as { share: { shortId: string } };

    assert.doesNotMatch(share.shortId, /[01loi]/i);
  });

  it('returns the existing link rather than minting a second', async () => {
    // A second link would be live and unrevokable from the UI, which can only
    // show one per file.
    const { res: first, account } = await makeShare();
    const one = (await first.json()) as { share: { shortId: string } };

    const second = await fetch(`${baseUrl}/api/shares`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, remoteId: 'file-1' }),
    });
    const two = (await second.json()) as { share: { shortId: string } };

    assert.equal(two.share.shortId, one.share.shortId);
    assert.equal(((await (await fetch(`${baseUrl}/api/shares`)).json()) as { shares: unknown[] }).shares.length, 1);
  });

  it('never returns the account or the provider id to a caller', async () => {
    const { res } = await makeShare();
    const body = await res.text();

    assert.ok(!body.includes('file-1'), 'the provider id must not travel to the client');
  });

  it('refuses an account that is not the caller\'s', async () => {
    stubFile();
    const res = await fetch(`${baseUrl}/api/shares`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'someone-elses', remoteId: 'file-1' }),
    });

    assert.equal(res.status, 404);
  });
});

describe('DELETE /api/shares/:shortId', () => {
  it('revokes the link, and the link then behaves as if it never existed', async () => {
    const { res } = await makeShare();
    const { share } = (await res.json()) as { share: { shortId: string } };

    assert.equal((await fetch(`${baseUrl}/api/shares/${share.shortId}`, { method: 'DELETE' })).status, 204);

    const visit = await fetch(`${baseUrl}/s/${share.shortId}`);
    assert.equal(visit.status, 404);
    // A revoked link and one that never existed answer identically, so the id
    // space cannot be probed for links that used to work.
    assert.match(await visit.text(), /does not work/);
  });
});

describe('GET /s/:shortId', () => {
  it('renders a page with the file name and a download button', async () => {
    const { res } = await makeShare();
    const { share } = (await res.json()) as { share: { shortId: string } };

    const page = await fetch(`${baseUrl}/s/${share.shortId}`);
    const html = await page.text();

    assert.equal(page.status, 200);
    assert.match(html, /beach\.jpg/);
    assert.match(html, /Download/);
    assert.match(html, /<img src="\/s\/[a-z2-9]+\/content"/);
  });

  it('runs no scripts, and says so in the policy', async () => {
    const { res } = await makeShare();
    const { share } = (await res.json()) as { share: { shortId: string } };

    const page = await fetch(`${baseUrl}/s/${share.shortId}`);
    const html = await page.text();

    assert.doesNotMatch(html, /<script/i);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  });

  it('keeps the page out of search indexes', async () => {
    const { res } = await makeShare();
    const { share } = (await res.json()) as { share: { shortId: string } };

    const page = await fetch(`${baseUrl}/s/${share.shortId}`);
    assert.match(page.headers.get('x-robots-tag') ?? '', /noindex/);
  });

  it('escapes a file name rather than rendering it as markup', async () => {
    // A file name is chosen by whoever made the file, which on a shared page
    // may not be the person who shared it.
    stubFile({ name: '<img src=x onerror=alert(1)>.jpg' });
    const account = await seedAccount();

    const created = await fetch(`${baseUrl}/api/shares`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, remoteId: 'file-1' }),
    });
    const { share } = (await created.json()) as { share: { shortId: string } };

    const html = await (await fetch(`${baseUrl}/s/${share.shortId}`)).text();
    assert.ok(!html.includes('<img src=x'), 'the name must not become markup');
    assert.match(html, /&lt;img src=x/);
  });

  it('does not preview an SVG, even though it is an image', async () => {
    // In an <img> it would be safe, but a share page is where a hostile file is
    // most likely to arrive, so it is offered as a download instead.
    stubFile({ name: 'logo.svg', mimeType: 'image/svg+xml' });
    const account = await seedAccount();

    const created = await fetch(`${baseUrl}/api/shares`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, remoteId: 'file-1' }),
    });
    const { share } = (await created.json()) as { share: { shortId: string } };

    const html = await (await fetch(`${baseUrl}/s/${share.shortId}`)).text();
    assert.doesNotMatch(html, /<img src="\/s\/[a-z2-9]+\/content"/);
  });

  it('shows an expired link as expired rather than as missing', async () => {
    const { res } = await makeShare({ expiresInDays: 1 });
    const { share } = (await res.json()) as { share: { shortId: string } };

    // Reach past the service to age the row, which is the only way to test an
    // expiry without waiting a day.
    const { shareLinks } = await import('@orbit/db');
    const { eq } = await import('drizzle-orm');
    const { db } = await import('../lib/db.js');
    await db()
      .update(shareLinks)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(shareLinks.shortId, share.shortId));

    const page = await fetch(`${baseUrl}/s/${share.shortId}`);
    assert.equal(page.status, 410);
    assert.match(await page.text(), /has expired/);
  });
});

describe('a password protected link', () => {
  async function makeLocked() {
    const { res } = await makeShare({ password: 'open-sesame' });
    const { share } = (await res.json()) as { share: { shortId: string; hasPassword: boolean } };
    return share;
  }

  it('says it has a password without returning the hash', async () => {
    const share = await makeLocked();
    assert.equal(share.hasPassword, true);

    const listed = await (await fetch(`${baseUrl}/api/shares`)).text();
    assert.ok(!listed.includes('passwordHash'));
  });

  it('asks for the password before showing anything', async () => {
    const share = await makeLocked();
    const page = await fetch(`${baseUrl}/s/${share.shortId}`);

    assert.equal(page.status, 401);
    const html = await page.text();
    assert.match(html, /password protected/);
    // The name is part of what the password protects.
    assert.doesNotMatch(html, /beach\.jpg/);
  });

  it('refuses the bytes to a visitor who has not unlocked it', async () => {
    const share = await makeLocked();
    assert.equal((await fetch(`${baseUrl}/s/${share.shortId}/content`)).status, 404);
  });

  it('re-asks on a wrong password rather than failing silently', async () => {
    const share = await makeLocked();

    const attempt = await fetch(`${baseUrl}/s/${share.shortId}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'wrong' }).toString(),
      redirect: 'manual',
    });

    assert.equal(attempt.status, 401);
    assert.match(await attempt.text(), /did not work/);
  });

  it('opens with the right password, and the bytes follow', async () => {
    const share = await makeLocked();

    const unlock = await fetch(`${baseUrl}/s/${share.shortId}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'open-sesame' }).toString(),
      redirect: 'manual',
    });

    // A redirect rather than a render, so refreshing does not resubmit.
    assert.equal(unlock.status, 303);
    const cookie = unlock.headers.get('set-cookie')?.split(';')[0] ?? '';
    assert.match(cookie, new RegExp(`orbit_share_${share.shortId}=`));

    const page = await fetch(`${baseUrl}/s/${share.shortId}`, { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /beach\.jpg/);

    const bytes = await fetch(`${baseUrl}/s/${share.shortId}/content`, { headers: { cookie } });
    assert.equal(bytes.status, 200);
  });

  it('does not put the password in the cookie', async () => {
    const share = await makeLocked();
    const unlock = await fetch(`${baseUrl}/s/${share.shortId}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'open-sesame' }).toString(),
      redirect: 'manual',
    });

    assert.ok(!(unlock.headers.get('set-cookie') ?? '').includes('open-sesame'));
  });
});

describe('GET /s/:shortId/content', () => {
  it('streams the bytes without naming the provider', async () => {
    const { res } = await makeShare();
    const { share } = (await res.json()) as { share: { shortId: string } };

    const bytes = await fetch(`${baseUrl}/s/${share.shortId}/content`);
    assert.equal(bytes.status, 200);
    assert.equal(bytes.headers.get('content-type'), 'image/jpeg');
    assert.equal(await bytes.text(), 'image-bytes');

    // Nothing in the response says where the file really lives.
    assert.equal(bytes.headers.get('location'), null);
    assert.match(bytes.headers.get('cache-control') ?? '', /no-store/);
  });

  it('counts an access', async () => {
    const { res } = await makeShare();
    const { share } = (await res.json()) as { share: { shortId: string } };

    await fetch(`${baseUrl}/s/${share.shortId}/content`);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { shares } = (await (await fetch(`${baseUrl}/api/shares`)).json()) as {
      shares: Array<{ accessCount: number }>;
    };
    assert.equal(shares[0]!.accessCount, 1);
  });

  it('offers a download only when the link permits it', async () => {
    const { res } = await makeShare({ permission: 'view' });
    const { share } = (await res.json()) as { share: { shortId: string } };

    const bytes = await fetch(`${baseUrl}/s/${share.shortId}/content?download`);
    assert.equal(bytes.headers.get('content-disposition'), null);
  });
});

describe('GET /s/:shortId/qr', () => {
  it('returns an SVG of the link', async () => {
    const { res } = await makeShare();
    const { share } = (await res.json()) as { share: { shortId: string } };

    const qr = await fetch(`${baseUrl}/s/${share.shortId}/qr`);
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type') ?? '', /image\/svg/);
    assert.match(await qr.text(), /<svg/);
  });

  it('gives nothing for a link that does not exist', async () => {
    assert.equal((await fetch(`${baseUrl}/s/nosuchlink123/qr`)).status, 404);
  });
});

describe('finding the link for one file', () => {
  it('narrows by account and remote id rather than by name', async () => {
    // Two files in different folders can share a name; matching on it would
    // show the wrong link, and revoking it would revoke the wrong file's.
    stubFile({ name: 'report.pdf' });
    const account = await seedAccount();

    for (const remoteId of ['file-a', 'file-b']) {
      await fetch(`${baseUrl}/api/shares`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: account.id, remoteId }),
      });
    }

    const query = new URLSearchParams({ accountId: account.id, remoteId: 'file-b' });
    const body = await (await fetch(`${baseUrl}/api/shares?${query.toString()}`)).text();
    const { shares } = JSON.parse(body) as { shares: Array<{ shortId: string }> };

    assert.equal(shares.length, 1);
    // Narrowed server-side: the provider's id is what the proxy keeps off the
    // client, so it must not come back even here.
    assert.ok(!body.includes('file-b'));
  });
});
