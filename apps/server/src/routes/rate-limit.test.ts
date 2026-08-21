import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

process.env.AUTH_MODE = 'hosted';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_SECRET ??= 'test-session-secret';
delete process.env.RESEND_API_KEY;
process.env.AUTH_RATE_LIMIT = '3';
process.env.AUTH_RATE_WINDOW_MS = '60000';

const { createApp } = await import('../app.js');
const { useTestDatabase } = await import('../test-utils.js');

let server: Server;
let baseUrl: string;

before(async () => {
  await useTestDatabase();
  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('auth rate limiting', () => {
  it('stops brute-force attempts once the limit is reached', async () => {
    const attempt = () =>
      fetch(`${baseUrl}/auth/verify-otp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'pilot@example.com', code: '000000' }),
      });

    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await attempt()).status);
    }

    assert.equal(statuses.filter((s) => s === 429).length, 2, `got ${statuses.join(',')}`);
    assert.equal(statuses.at(-1), 429);
  });
});

describe('what the strict auth limiter covers', () => {
  it('does not spend the OTP budget on reading a session', async () => {
    // AUTH_RATE_LIMIT is 3 here. Applied to all of /auth, these calls would use
    // it up and the next sign-in attempt would be refused - so a few open tabs
    // locked someone out of their own account for the rest of the window.
    for (let i = 0; i < 8; i += 1) {
      const res = await fetch(`${baseUrl}/auth/mode`);
      assert.equal(res.status, 200, `call ${i + 1} should not be limited`);
    }
  });

  it('still limits the endpoint that guesses codes', async () => {
    const seen: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`${baseUrl}/auth/verify-otp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.com', code: '000000' }),
      });
      seen.push(res.status);
    }

    assert.ok(seen.includes(429), `expected a refusal among ${seen.join(', ')}`);
  });
});
