import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ProviderError } from './base.js';
import { providerFetch } from './http.js';

const real = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = real;
});

/** Replays the given responses in order, and counts the calls. */
function replay(responses: Array<() => Response>): { calls: () => number } {
  let calls = 0;

  globalThis.fetch = async () => {
    const next = responses[Math.min(calls, responses.length - 1)]!;
    calls += 1;
    return next();
  };

  return { calls: () => calls };
}

const ok = () => new Response('{}', { status: 200 });

/** What Drive actually sends when the per-user limit bites. */
const driveRateLimit = () =>
  new Response(
    JSON.stringify({
      error: {
        code: 403,
        message: 'User rate limit exceeded.',
        errors: [{ reason: 'userRateLimitExceeded', message: 'User rate limit exceeded.' }],
      },
    }),
    { status: 403, headers: { 'retry-after': '0' } },
  );

/** And what it sends when the file is simply not yours to touch. */
const forbidden = () =>
  new Response(
    JSON.stringify({
      error: {
        code: 403,
        message: 'The user does not have sufficient permissions for this file.',
        errors: [{ reason: 'insufficientFilePermissions' }],
      },
    }),
    { status: 403 },
  );

describe('retrying a rate limit', () => {
  /*
   * Drive answers a rate limit with 403 at least as often as with 429. Treated
   * as a plain 403 it was a permanent failure, so one throttled file in a bulk
   * delete was reported as undeletable rather than retried.
   */
  it('retries a 403 that means "slow down"', async () => {
    const seen = replay([driveRateLimit, ok]);

    const response = await providerFetch('google_drive', 'https://example.test/x');

    assert.equal(response.status, 200);
    assert.equal(seen.calls(), 2);
  });

  it('retries 429 and the transient server errors', async () => {
    for (const status of [429, 500, 503]) {
      const seen = replay([() => new Response('slow down', { status }), ok]);

      await providerFetch('google_drive', 'https://example.test/x');
      assert.equal(seen.calls(), 2, `status ${status}`);
    }
  });

  /*
   * The distinction that makes the above safe. Retrying a permission error
   * would turn one refusal into six, which is how an account gets throttled
   * for real.
   */
  it('does not retry a 403 that means "not yours"', async () => {
    const seen = replay([forbidden]);

    await assert.rejects(
      () => providerFetch('google_drive', 'https://example.test/x'),
      (err: unknown) => err instanceof ProviderError && err.status === 403,
    );
    assert.equal(seen.calls(), 1);
  });

  it('does not retry a 404', async () => {
    const seen = replay([() => new Response('gone', { status: 404 })]);

    await assert.rejects(() => providerFetch('google_drive', 'https://example.test/x'));
    assert.equal(seen.calls(), 1);
  });

  it('gives up after the attempt ceiling rather than retrying for ever', async () => {
    const seen = replay([driveRateLimit]);

    await assert.rejects(
      () => providerFetch('google_drive', 'https://example.test/x'),
      (err: unknown) => err instanceof ProviderError && err.status === 403,
    );
    assert.equal(seen.calls(), 6);
  });

  /*
   * The body is read once and reused for both decisions. Reading it twice
   * threw "body used already", which surfaced as an unrelated error in place
   * of the quota message.
   */
  it('still reports the provider message after inspecting the body', async () => {
    replay([forbidden]);

    await assert.rejects(
      () => providerFetch('google_drive', 'https://example.test/x'),
      (err: unknown) =>
        err instanceof ProviderError && err.message.includes('sufficient permissions'),
    );
  });
});
