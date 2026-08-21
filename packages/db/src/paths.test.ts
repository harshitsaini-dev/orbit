import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { REPO_ROOT, defaultLocalDatabaseUrl, resolveDatabaseUrl } from './paths.js';

const rootDb = pathToFileURL(resolve(REPO_ROOT, 'orbit.db')).href;

describe('resolveDatabaseUrl', () => {
  it('falls back to the repo-root file when unset', () => {
    assert.equal(resolveDatabaseUrl(undefined), rootDb);
  });

  it('treats a blank value as unset', () => {
    assert.equal(resolveDatabaseUrl(''), rootDb);
    assert.equal(resolveDatabaseUrl('   '), rootDb);
  });

  it('resolves a relative file URL against the repo root, not the working directory', () => {
    // The bug this guards: the server starts in apps/server and drizzle-kit in
    // packages/db, so `file:./orbit.db` used to open three different databases.
    assert.equal(resolveDatabaseUrl('file:./orbit.db'), rootDb);
    assert.equal(resolveDatabaseUrl('file:orbit.db'), rootDb);
  });

  it('resolves a relative sub-path against the repo root too', () => {
    assert.equal(
      resolveDatabaseUrl('file:./data/orbit.db'),
      pathToFileURL(resolve(REPO_ROOT, 'data/orbit.db')).href,
    );
  });

  it('leaves an absolute file URL alone', () => {
    const absolute = pathToFileURL(resolve(REPO_ROOT, 'elsewhere.db')).href;
    assert.equal(resolveDatabaseUrl(absolute), absolute);
  });

  it('leaves a remote URL alone', () => {
    assert.equal(resolveDatabaseUrl('libsql://orbit-prod.turso.io'), 'libsql://orbit-prod.turso.io');
    assert.equal(resolveDatabaseUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(resolveDatabaseUrl('  libsql://x.turso.io  '), 'libsql://x.turso.io');
  });
});

describe('defaultLocalDatabaseUrl', () => {
  it('points at the repo root regardless of the working directory', () => {
    assert.equal(defaultLocalDatabaseUrl(), rootDb);
    assert.match(defaultLocalDatabaseUrl(), /^file:\/\/\//);
  });
});
