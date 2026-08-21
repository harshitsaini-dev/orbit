import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { PROVIDER_IDS } from '@orbit/shared-types';
import { createApp } from './app.js';

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

describe('GET /health', () => {
  it('reports ok with the active auth mode', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; mode: string };
    assert.equal(body.status, 'ok');
    assert.ok(['local', 'hosted'].includes(body.mode));
  });
});

describe('GET /health/providers', () => {
  it('lists every registered provider', async () => {
    const res = await fetch(`${baseUrl}/health/providers`);
    const body = (await res.json()) as { providers: Array<{ id: string }> };
    assert.deepEqual(
      body.providers.map((p) => p.id).sort(),
      [...PROVIDER_IDS].sort(),
    );
  });
});

describe('unknown routes', () => {
  it('returns a structured 404', async () => {
    const res = await fetch(`${baseUrl}/does-not-exist`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'not_found');
  });
});
