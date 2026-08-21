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
