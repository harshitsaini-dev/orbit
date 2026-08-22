import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { PROVIDER_CATALOGUE, PROVIDER_IDS, UNAVAILABLE_PROVIDERS } from '@orbit/shared-types';
import { createApp } from './app.js';
import { useTestDatabase } from './test-utils.js';

let server: Server;
let baseUrl: string;

before(async () => {
  // Against a throwaway database like every other route test. Without this the
  // suite ran on the developer's own orbit.db, and a schema change that had not
  // been applied there yet failed here rather than where it belonged.
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

describe('GET /api/catalogue', () => {
  it('offers every catalogue entry, with the adapter capabilities attached', async () => {
    const res = await fetch(`${baseUrl}/api/catalogue`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as {
      entries: Array<{ key: string; provider: string; capabilities: Record<string, boolean> }>;
      unavailable: Array<{ key: string; reason: string }>;
    };

    assert.deepEqual(
      body.entries.map((entry) => entry.key).sort(),
      PROVIDER_CATALOGUE.map((entry) => entry.key).sort(),
    );

    for (const entry of body.entries) {
      assert.equal(typeof entry.capabilities.rangeRequests, 'boolean', `${entry.key} has no capabilities`);
    }
  });

  it('reports the services Orbit cannot support, with reasons', async () => {
    const res = await fetch(`${baseUrl}/api/catalogue`);
    const body = (await res.json()) as { unavailable: Array<{ key: string; reason: string }> };

    assert.deepEqual(
      body.unavailable.map((entry) => entry.key).sort(),
      UNAVAILABLE_PROVIDERS.map((entry) => entry.key).sort(),
    );
    for (const entry of body.unavailable) assert.ok(entry.reason.length > 0);
  });

  it('never exposes a stored credential', async () => {
    const res = await fetch(`${baseUrl}/api/catalogue`);
    const raw = await res.text();
    // Field definitions describe what to ask for; they must carry no values.
    assert.ok(!/secretAccessKey"\s*:\s*"[^"]+"/.test(raw));
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
