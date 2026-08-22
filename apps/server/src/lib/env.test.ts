import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { productionProblems, type ProductionConfig } from './env.js';

/** A deployment that is actually configured correctly. */
const SOUND: ProductionConfig = {
  AUTH_MODE: 'hosted',
  ENABLE_DEV_AUTH_ENDPOINTS: false,
  DATABASE_URL: 'libsql://orbit.turso.io',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  SESSION_SECRET: 'a'.repeat(48),
  APP_URL: 'https://orbit.harshitsaini.in',
  API_URL: 'https://api.orbit.harshitsaini.in',
};

function problemsWith(overrides: Partial<ProductionConfig>): string[] {
  return productionProblems({ ...SOUND, ...overrides });
}

describe('productionProblems', () => {
  it('passes a deployment that is set up properly', () => {
    assert.deepEqual(productionProblems(SOUND), []);
  });

  it('refuses local mode, which is a workspace with no sign-in', () => {
    // The worst of these by a distance: it starts, it serves, and every
    // request is one implicit user. On a public host that is an open drive.
    assert.match(problemsWith({ AUTH_MODE: 'local' }).join(), /AUTH_MODE/);
  });

  it('refuses the endpoint that reads back OTP codes', () => {
    assert.match(problemsWith({ ENABLE_DEV_AUTH_ENDPOINTS: true }).join(), /ENABLE_DEV_AUTH/);
  });

  it('refuses a database that lives inside the container', () => {
    // It works, right up to the next deploy, and then every account is gone.
    assert.match(problemsWith({ DATABASE_URL: undefined }).join(), /DATABASE_URL/);
  });

  it('refuses an encryption key that is not 32 bytes', () => {
    // AES-256 wants exactly that. A short key fails somewhere later, on a path
    // that is holding somebody's provider tokens.
    const short = Buffer.alloc(16, 1).toString('base64');
    assert.match(problemsWith({ TOKEN_ENCRYPTION_KEY: short }).join(), /32 bytes/);
  });

  it('refuses a session secret short enough to be guessed', () => {
    assert.match(problemsWith({ SESSION_SECRET: 'short' }).join(), /SESSION_SECRET/);
  });

  it('refuses plain HTTP, which silently drops every secure cookie', () => {
    const problems = problemsWith({
      APP_URL: 'http://orbit.harshitsaini.in',
      API_URL: 'http://api.orbit.harshitsaini.in',
    });

    assert.equal(problems.filter((line) => line.includes('https')).length, 2);
  });

  it('reports every problem at once', () => {
    // Somebody fixing a deployment wants the whole list, not one per restart.
    const problems = problemsWith({
      AUTH_MODE: 'local',
      DATABASE_URL: undefined,
      APP_URL: 'http://x.test',
    });

    assert.equal(problems.length, 3);
  });
});
