import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { V1_ENDPOINTS } from '@orbit/shared-types';

process.env.AUTH_MODE = 'local';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_SECRET ??= 'test-session-secret';

const { v1Router } = await import('./v1.js');

/**
 * The documentation and the router, checked against each other.
 *
 * This is the reason the API surface is written down as data rather than as a
 * page of prose. Hand-written API documentation is wrong within a release -
 * not through carelessness, but because the code changes and the prose has no
 * way to notice. Here it does: an endpoint added without an entry fails, and
 * an entry describing something that no longer exists fails too.
 */

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
}

/** Every (method, path) express will actually answer. */
function registeredRoutes(): Set<string> {
  const found = new Set<string>();

  for (const layer of (v1Router as unknown as { stack: Layer[] }).stack) {
    if (!layer.route) continue;

    for (const [method, on] of Object.entries(layer.route.methods)) {
      if (on) found.add(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }

  return found;
}

const documented = new Set(V1_ENDPOINTS.map((entry) => `${entry.method} ${entry.path}`));

describe('the documented API and the real one', () => {
  it('documents every endpoint the router answers', () => {
    const missing = [...registeredRoutes()].filter((route) => !documented.has(route));

    assert.deepEqual(
      missing,
      [],
      `these endpoints exist and are undocumented: ${missing.join(', ')}`,
    );
  });

  it('documents nothing the router does not answer', () => {
    // The other direction, and the one that rots quietly: an endpoint removed
    // leaves a page telling people to call something that 404s.
    const registered = registeredRoutes();
    const invented = [...documented].filter((route) => !registered.has(route));

    assert.deepEqual(invented, [], `these are documented and do not exist: ${invented.join(', ')}`);
  });

  it('names a scope for everything except /v1/me', () => {
    // Every route on the router carries a requireScope gate; /me deliberately
    // does not, because a token must be able to ask what it may do.
    for (const entry of V1_ENDPOINTS) {
      if (entry.path === '/v1/me') {
        assert.equal(entry.scope, null);
        continue;
      }

      assert.ok(entry.scope, `${entry.path} has no scope`);
    }
  });

  it('describes every parameter it names', () => {
    for (const entry of V1_ENDPOINTS) {
      for (const param of entry.params) {
        assert.ok(param.description.length > 10, `${entry.path}: ${param.name} says nothing`);
      }

      // A path parameter in the URL must appear in the list, or a reader has
      // no way to know what to put there.
      for (const segment of entry.path.split('/')) {
        if (!segment.startsWith(':')) continue;

        const name = segment.slice(1);
        assert.ok(
          entry.params.some((param) => param.in === 'path' && param.name === name),
          `${entry.path} takes :${name} and does not document it`,
        );
      }
    }
  });

  it('shows a response for every endpoint', () => {
    for (const entry of V1_ENDPOINTS) {
      assert.ok(entry.response.trim().length > 0, `${entry.path} shows no response`);
    }
  });
});
