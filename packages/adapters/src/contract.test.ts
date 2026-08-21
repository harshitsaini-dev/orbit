import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROVIDER_IDS } from '@orbit/shared-types';
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
        for (const key of ['star', 'sharedWithMe', 'delta', 'resumableUpload', 'rangeRequests']) {
          assert.equal(typeof (adapter.capabilities as Record<string, unknown>)[key], 'boolean');
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
