import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PROVIDER_CATALOGUE,
  PROVIDER_IDS,
  catalogueEntry,
  resolveEndpoint,
} from '@orbit/shared-types';
import { getAdapter, listAdapters, normalisePath, joinPath } from './index.js';

/**
 * The shared adapter contract suite. Every provider must satisfy this before it
 * is wired into the allocation engine (see CLAUDE.md).
 */
const REQUIRED_METHODS = [
  'connect',
  'refreshToken',
  'listFolder',
  'getFileMeta',
  'getFileStream',
  'createFolder',
  'rename',
  'remove',
  'star',
  'initUpload',
  'uploadChunk',
  'getQuota',
  'listChangesSince',
] as const;

describe('provider registry', () => {
  it('exposes exactly one adapter per declared provider id', () => {
    assert.equal(listAdapters().length, PROVIDER_IDS.length);
  });

  for (const id of PROVIDER_IDS) {
    describe(id, () => {
      const adapter = getAdapter(id);

      it('reports its own id', () => {
        assert.equal(adapter.id, id);
      });

      it('declares a display name and auth type', () => {
        assert.ok(adapter.displayName.length > 0);
        assert.ok(['oauth', 'account_password', 'access_key'].includes(adapter.authType));
      });

      it('declares every capability flag', () => {
        for (const key of [
          'star',
          'sharedWithMe',
          'delta',
          'resumableUpload',
          'rangeRequests',
          'nativeFolders',
          'reportsQuota',
        ]) {
          assert.equal(typeof (adapter.capabilities as unknown as Record<string, unknown>)[key], 'boolean');
        }
      });

      it('implements every method on the contract', () => {
        for (const method of REQUIRED_METHODS) {
          assert.equal(typeof adapter[method], 'function', `${id} is missing ${method}()`);
        }
      });
    });
  }
});

describe('path normalisation', () => {
  it('always produces a leading slash and no trailing slash', () => {
    assert.equal(normalisePath('Photos/2026/'), '/Photos/2026');
    assert.equal(normalisePath('/Photos//2026'), '/Photos/2026');
    assert.equal(normalisePath(''), '/');
    assert.equal(normalisePath('/'), '/');
  });

  it('joins a child onto a parent path', () => {
    assert.equal(joinPath('/', 'Photos'), '/Photos');
    assert.equal(joinPath('/Photos/', 'trip.jpg'), '/Photos/trip.jpg');
  });
});

describe('provider catalogue', () => {
  it('has a unique key for every entry', () => {
    const keys = PROVIDER_CATALOGUE.map((entry) => entry.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  it('only points at adapters that exist', () => {
    for (const entry of PROVIDER_CATALOGUE) {
      assert.ok(PROVIDER_IDS.includes(entry.provider), `${entry.key} -> unknown adapter ${entry.provider}`);
    }
  });

  it('offers at least one entry for every adapter', () => {
    for (const id of PROVIDER_IDS) {
      assert.ok(
        PROVIDER_CATALOGUE.some((entry) => entry.provider === id),
        `no catalogue entry reaches the ${id} adapter`,
      );
    }
  });

  it('collects every placeholder its endpoint template needs', () => {
    for (const entry of PROVIDER_CATALOGUE) {
      if (!entry.endpointTemplate) continue;
      const placeholders = [...entry.endpointTemplate.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const collected = new Set((entry.fields ?? []).map((field) => field.name));
      for (const placeholder of placeholders) {
        assert.ok(
          collected.has(placeholder!),
          `${entry.key} templates {${placeholder}} but never asks the user for it`,
        );
      }
    }
  });

  it('asks for credentials on every access-key entry', () => {
    for (const entry of PROVIDER_CATALOGUE) {
      if (entry.provider !== 's3') continue;
      const names = new Set((entry.fields ?? []).map((field) => field.name));
      assert.ok(names.has('accessKeyId'), `${entry.key} never asks for an access key`);
      assert.ok(names.has('bucket'), `${entry.key} never asks for a bucket`);
    }
  });

  it('marks every secret field as secret', () => {
    for (const entry of PROVIDER_CATALOGUE) {
      for (const field of entry.fields ?? []) {
        if (/secret|password|key$|Key$|Json$/.test(field.name) && field.name !== 'accessKeyId') {
          assert.equal(field.secret, true, `${entry.key}.${field.name} is not marked secret`);
        }
      }
    }
  });

  it('resolves an endpoint from collected values', () => {
    const r2 = catalogueEntry('cloudflare_r2');
    assert.ok(r2);
    assert.equal(
      resolveEndpoint(r2, { accountId: 'abc123' }),
      'https://abc123.r2.cloudflarestorage.com',
    );
  });

  it('falls back to a typed endpoint when there is no template', () => {
    const other = catalogueEntry('s3_other');
    assert.ok(other);
    assert.equal(resolveEndpoint(other, { endpoint: 'https://s3.example.com' }), 'https://s3.example.com');
  });
});

