import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_SECRET ??= 'test-session-secret';
process.env.API_RATE_LIMIT = '10000';

const { createApp } = await import('../app.js');
const { useTestDatabase } = await import('../test-utils.js');
const { setDatabase } = await import('../lib/db.js');

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

describe('GET /health/ready', () => {
  it('reports ready when the database answers', async () => {
    const res = await fetch(`${baseUrl}/health/ready`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ready: true });
  });

  it('reports 503 when it cannot, so traffic is not sent here', async () => {
    /*
     * The whole point of this route. /health answers from memory and would
     * still say "ok" with the database unreachable, which is exactly the
     * instance a deploy must not switch traffic to.
     */
    setDatabase({
      run: () => Promise.reject(new Error('connection refused')),
    } as unknown as Parameters<typeof setDatabase>[0]);

    const res = await fetch(`${baseUrl}/health/ready`);

    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ready: false, reason: 'database_unreachable' });
  });

  it('does not say why, beyond that it was the database', async () => {
    // A readiness probe is unauthenticated; the connection string and the
    // driver's own message stay in the log.
    setDatabase({
      run: () => Promise.reject(new Error('libsql://orbit-prod.turso.io refused')),
    } as unknown as Parameters<typeof setDatabase>[0]);

    const body = await (await fetch(`${baseUrl}/health/ready`)).text();
    assert.equal(body.includes('turso.io'), false);
  });
});

describe('request ids', () => {
  it('gives every response one, and puts it in the error a user sees', async () => {
    // "It said something went wrong" is unanswerable without this; with it,
    // one line of log explains the failure.
    const res = await fetch(`${baseUrl}/api/nothing-here`);
    const header = res.headers.get('x-request-id');
    const body = (await res.json()) as { error: { requestId?: string } };

    assert.ok(header, 'no id on the response');
    assert.equal(body.error.requestId, header);
  });

  it('gives a different one to each request', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      ids.add((await fetch(`${baseUrl}/health`)).headers.get('x-request-id') ?? '');
    }

    assert.equal(ids.size, 3);
  });

  it('keeps an id a proxy supplied, so one trace covers both hops', async () => {
    const res = await fetch(`${baseUrl}/health`, { headers: { 'x-request-id': 'edge-12345' } });
    assert.equal(res.headers.get('x-request-id'), 'edge-12345');
  });

  it('refuses one a stranger made up out of anything but a short id', async () => {
    // It is a header anyone can set, and it ends up on every line about the
    // request - so a newline or a kilobyte of text in it is a log injection.
    const res = await fetch(`${baseUrl}/health`, {
      headers: { 'x-request-id': 'a'.repeat(200) },
    });

    const id = res.headers.get('x-request-id') ?? '';
    assert.notEqual(id, 'a'.repeat(200));
    assert.match(id, /^[0-9a-f]{16}$/);
  });
});
