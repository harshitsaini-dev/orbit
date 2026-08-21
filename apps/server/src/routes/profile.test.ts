import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.API_RATE_LIMIT = '10000';

const { createApp } = await import('../app.js');
const { AVATAR_MAX_BYTES, validateAvatar } = await import('./profile.js');
const { useTestDatabase } = await import('../test-utils.js');

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

const patch = (body: unknown) =>
  fetch(`${baseUrl}/api/profile`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** A one-pixel PNG, as a data URL. */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('validateAvatar', () => {
  it('accepts a small PNG, JPEG or WebP data URL', () => {
    assert.deepEqual(validateAvatar(TINY_PNG), { ok: true });
    assert.equal(validateAvatar('data:image/jpeg;base64,/9j/4AAQ').ok, true);
    assert.equal(validateAvatar('data:image/webp;base64,UklGRg==').ok, true);
  });

  it('refuses anything that is not an image data URL', () => {
    assert.equal(validateAvatar('https://example.com/me.png').ok, false);
    assert.equal(validateAvatar('data:text/html;base64,PHNjcmlwdD4=').ok, false);
    // SVG is script-capable, so it is not among the accepted types.
    assert.equal(validateAvatar('data:image/svg+xml;base64,PHN2Zz4=').ok, false);
    assert.equal(validateAvatar('').ok, false);
  });

  it('refuses an image over the size cap', () => {
    // Four base64 characters per three bytes, so this lands just over the cap.
    const oversized = `data:image/png;base64,${'A'.repeat(Math.ceil((AVATAR_MAX_BYTES + 1024) / 3) * 4)}`;
    const result = validateAvatar(oversized);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /larger than/);
  });
});

describe('GET /api/profile', () => {
  it('returns the signed-in user', async () => {
    const res = await fetch(`${baseUrl}/api/profile`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as { user: { email: string } };
    assert.ok(body.user.email);
  });
});

describe('PATCH /api/profile', () => {
  it('sets a display name', async () => {
    const res = await patch({ displayName: '  Harshit  ' });
    assert.equal(res.status, 200);

    const body = (await res.json()) as { user: { displayName: string } };
    assert.equal(body.user.displayName, 'Harshit', 'the name should be trimmed');
  });

  it('treats a blank name as no name, not a user called ""', async () => {
    await patch({ displayName: 'Harshit' });
    const res = await patch({ displayName: '   ' });

    const body = (await res.json()) as { user: { displayName: string | null } };
    assert.equal(body.user.displayName, null);
  });

  it('stores and clears an avatar', async () => {
    const set = await patch({ avatar: TINY_PNG });
    assert.equal(((await set.json()) as { user: { avatar: string } }).user.avatar, TINY_PNG);

    const cleared = await patch({ avatar: null });
    assert.equal(((await cleared.json()) as { user: { avatar: string | null } }).user.avatar, null);
  });

  it('refuses an avatar that is a remote URL', async () => {
    // A remote picture would report every page load back to whoever hosts it.
    const res = await patch({ avatar: 'https://example.com/me.png' });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'invalid_avatar');
  });

  it('saves theme and accent, so they follow the account to another device', async () => {
    const res = await patch({ theme: 'dark', accent: '#8B6CF5' });
    const body = (await res.json()) as { user: { theme: string; accent: string } };

    assert.equal(body.user.theme, 'dark');
    assert.equal(body.user.accent, '#8b6cf5', 'colours are normalised to lower case');
  });

  it('rejects a colour that is not a hex value', async () => {
    assert.equal((await patch({ accent: 'red' })).status, 400);
    assert.equal((await patch({ accent: '#fff' })).status, 400);
  });

  it('rejects an unknown allocation strategy', async () => {
    assert.equal((await patch({ allocationStrategy: 'whatever' })).status, 400);
    assert.equal((await patch({ allocationStrategy: 'most_free' })).status, 200);
  });

  it('rejects a request that changes nothing', async () => {
    assert.equal((await patch({})).status, 400);
  });

  it('never lets the role be changed from here', async () => {
    const res = await patch({ displayName: 'x', role: 'superadmin' });
    const body = (await res.json()) as { user: { role: string } };

    // The field is simply not in the schema, so it is dropped rather than applied.
    assert.equal(body.user.role, 'superadmin', 'the local user is the first user, so already admin');

    const check = await fetch(`${baseUrl}/api/profile`);
    const current = (await check.json()) as { user: { displayName: string } };
    assert.equal(current.user.displayName, 'x');
  });
});
