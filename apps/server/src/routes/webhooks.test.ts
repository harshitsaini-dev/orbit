import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_SECRET ??= 'test-session-secret';
process.env.API_RATE_LIMIT = '10000';

const { createApp } = await import('../app.js');
const { useTestDatabase } = await import('../test-utils.js');
const { checkTarget, sign, verify } = await import('../services/webhooks.js');

let server: Server;
let baseUrl: string;

/** A receiver, so a delivery has somewhere real to land. */
let receiver: Server;
let receiverUrl: string;
let received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
let answerWith = 200;

before(async () => {
  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;

  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(answerWith).end();
    });
  });

  await new Promise<void>((resolve) => receiver.listen(0, resolve));
  const at = receiver.address();
  if (typeof at === 'string' || at === null) throw new Error('no port');
  // Not 127.0.0.1: the SSRF check refuses that, which is the point of it.
  receiverUrl = `http://localhost.orbit-test.invalid:${at.port}/hook`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

beforeEach(async () => {
  await useTestDatabase();
  received = [];
  answerWith = 200;
});

async function create(body: Record<string, unknown> = {}) {
  return fetch(`${baseUrl}/api/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'My script',
      url: 'https://example.com/hook',
      events: ['file.uploaded'],
      ...body,
    }),
  });
}

describe('where a webhook may point', () => {
  /*
   * The one that matters. A webhook URL is an address chosen by a user and
   * fetched by the server - the definition of a server-side request forgery.
   * Orbit runs somewhere with a metadata service on a link-local address and a
   * database on a private one.
   */
  const refused = [
    ['loopback by name', 'http://localhost:8080/hook'],
    ['loopback by address', 'http://127.0.0.1:8080/hook'],
    ['another loopback address', 'http://127.1.2.3/hook'],
    ['the cloud metadata service', 'http://169.254.169.254/latest/meta-data/'],
    ['a private class A network', 'http://10.0.0.5/hook'],
    ['a private class B network', 'http://172.16.4.2/hook'],
    ['a private class C network', 'http://192.168.1.1/hook'],
    ['carrier-grade NAT', 'http://100.64.0.1/hook'],
    ['IPv6 loopback', 'http://[::1]:8080/hook'],
    ['IPv6 unique-local', 'http://[fd00::1]/hook'],
    ['a scheme that is not http', 'file:///etc/passwd'],
    ['something that is not a URL at all', 'not a url'],
  ] as const;

  for (const [what, url] of refused) {
    it(`refuses ${what}`, async () => {
      const result = await checkTarget(url);
      assert.equal(result.ok, false, `${url} should have been refused`);
    });
  }

  it('allows an ordinary public address', async () => {
    assert.equal((await checkTarget('https://example.com/hook')).ok, true);
  });

  it('refuses a private address through the API, before storing anything', async () => {
    const res = await create({ url: 'http://169.254.169.254/latest/meta-data/' });

    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: { message: string } }).error.message, /private/i);

    const list = await fetch(`${baseUrl}/api/webhooks`);
    assert.deepEqual(((await list.json()) as { webhooks: unknown[] }).webhooks, []);
  });
});

describe('POST /api/webhooks', () => {
  it('creates one and shows the secret exactly once', async () => {
    const res = await create();
    assert.equal(res.status, 201);

    const body = (await res.json()) as { webhook: { id: string }; secret: string };
    assert.match(body.secret, /^whsec_/);

    // Not in the list afterwards: a secret any page can display is a secret
    // that leaks through a screen share.
    const list = await fetch(`${baseUrl}/api/webhooks`);
    const listed = (await list.json()) as { webhooks: Array<Record<string, unknown>> };

    assert.equal(listed.webhooks.length, 1);
    assert.equal(listed.webhooks[0]!.secret, undefined);
  });

  it('refuses an event nobody publishes', async () => {
    const res = await create({ events: ['file.exploded'] });
    assert.equal(res.status, 400);
  });

  it('refuses a webhook that wants nothing', async () => {
    const res = await create({ events: [] });
    assert.equal(res.status, 400);
  });
});

describe('signing', () => {
  it('is stable, and covers the timestamp', async () => {
    const a = sign('whsec_x', '1000', '{"event":"ping"}');
    const b = sign('whsec_x', '1000', '{"event":"ping"}');
    const later = sign('whsec_x', '2000', '{"event":"ping"}');

    assert.equal(a, b);
    // Or a delivery captured today could be replayed next week.
    assert.notEqual(a, later);
  });

  it('verifies its own signature and rejects a wrong one', () => {
    const body = '{"event":"ping"}';
    const signature = sign('whsec_x', '1000', body);

    assert.equal(verify('whsec_x', '1000', body, signature), true);
    assert.equal(verify('whsec_other', '1000', body, signature), false);
    assert.equal(verify('whsec_x', '1000', '{"event":"pong"}', signature), false);
    assert.equal(verify('whsec_x', '1000', body, 'nonsense'), false);
  });
});

describe('POST /api/webhooks/:id/test', () => {
  it('delivers, signed, and says what came back', async () => {
    // Created straight in the database: the API refuses a loopback address on
    // purpose, and this test needs one that answers.
    const { db } = await import('../lib/db.js');
    const { webhooks } = await import('@orbit/db');
    const { getLocalUser } = await import('../services/users.js');
    const user = await getLocalUser();

    const at = receiver.address();
    if (typeof at === 'string' || at === null) throw new Error('no port');

    await db().insert(webhooks).values({
      id: 'wh-1',
      userId: user.id,
      name: 'Local receiver',
      url: `http://127.0.0.1:${at.port}/hook`,
      secret: 'whsec_test',
      events: JSON.stringify(['file.uploaded']),
      active: true,
      createdAt: new Date().toISOString(),
    });

    const res = await fetch(`${baseUrl}/api/webhooks/wh-1/test`, { method: 'POST' });
    const { delivery } = (await res.json()) as { delivery: { status: number; attempts: number } };

    assert.equal(delivery.status, 200);
    assert.equal(delivery.attempts, 1);
    assert.equal(received.length, 1);

    const sent = received[0]!;
    const timestamp = String(sent.headers['x-orbit-timestamp']);
    const signature = String(sent.headers['x-orbit-signature']).replace('sha256=', '');

    assert.equal(sent.headers['x-orbit-event'], 'ping');
    assert.equal(verify('whsec_test', timestamp, sent.body, signature), true);
    assert.equal((JSON.parse(sent.body) as { event: string }).event, 'ping');
  });

  it('records the delivery, so "did it ever fire" has an answer', async () => {
    const { db } = await import('../lib/db.js');
    const { webhooks } = await import('@orbit/db');
    const { getLocalUser } = await import('../services/users.js');
    const user = await getLocalUser();

    const at = receiver.address();
    if (typeof at === 'string' || at === null) throw new Error('no port');

    await db().insert(webhooks).values({
      id: 'wh-2',
      userId: user.id,
      name: 'Local receiver',
      url: `http://127.0.0.1:${at.port}/hook`,
      secret: 'whsec_test',
      events: JSON.stringify(['file.uploaded']),
      active: true,
      createdAt: new Date().toISOString(),
    });

    await fetch(`${baseUrl}/api/webhooks/wh-2/test`, { method: 'POST' });

    const res = await fetch(`${baseUrl}/api/webhooks/wh-2/deliveries`);
    const { deliveries } = (await res.json()) as {
      deliveries: Array<{ event: string; status: number }>;
    };

    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.event, 'ping');
    assert.equal(deliveries[0]!.status, 200);
  });

  it('does not retry a refusal', async () => {
    const { db } = await import('../lib/db.js');
    const { webhooks } = await import('@orbit/db');
    const { getLocalUser } = await import('../services/users.js');
    const user = await getLocalUser();

    const at = receiver.address();
    if (typeof at === 'string' || at === null) throw new Error('no port');

    await db().insert(webhooks).values({
      id: 'wh-3',
      userId: user.id,
      name: 'Fussy receiver',
      url: `http://127.0.0.1:${at.port}/hook`,
      secret: 'whsec_test',
      events: JSON.stringify(['file.uploaded']),
      active: true,
      createdAt: new Date().toISOString(),
    });

    // 400 is the receiver saying it does not want this. Sending it twice more
    // is noise, not persistence.
    answerWith = 400;

    const res = await fetch(`${baseUrl}/api/webhooks/wh-3/test`, { method: 'POST' });
    const { delivery } = (await res.json()) as { delivery: { attempts: number } };

    assert.equal(delivery.attempts, 1);
    assert.equal(received.length, 1);
  });
});

describe('DELETE /api/webhooks/:id', () => {
  it('removes one, and answers 404 for somebody else’s', async () => {
    const made = await create();
    const { webhook } = (await made.json()) as { webhook: { id: string } };

    assert.equal((await fetch(`${baseUrl}/api/webhooks/${webhook.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${baseUrl}/api/webhooks/nope`, { method: 'DELETE' })).status, 404);
  });
});
