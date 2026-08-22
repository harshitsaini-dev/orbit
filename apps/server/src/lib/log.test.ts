import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redact } from './log.js';

/**
 * These are the cases that actually leak a token in practice. None of them is
 * somebody writing `log.info(token)`; each is a token arriving inside
 * something else that looked harmless to write down.
 */

describe('redact', () => {
  it('drops anything whose name says it is a secret', () => {
    const out = redact({
      accountId: 'abc',
      accessToken: 'ya29.real-token',
      refresh_token: 'real-refresh',
      SESSION_SECRET: 'real-secret',
      password: 'hunter2',
    }) as Record<string, unknown>;

    assert.equal(out['accountId'], 'abc');
    for (const key of ['accessToken', 'refresh_token', 'SESSION_SECRET', 'password']) {
      assert.equal(out[key], '[redacted]', `${key} was written out`);
    }
  });

  it('reaches a secret nested inside something else', () => {
    // How one usually arrives: not as a field, but inside the account object
    // somebody logged to see which account failed.
    const out = redact({ account: { nickname: 'me@example.com', tokens: { accessToken: 'ya29.x' } } });

    assert.equal(JSON.stringify(out).includes('ya29.x'), false);
    assert.match(JSON.stringify(out), /me@example\.com/);
  });

  it('strips a token out of a URL, which is where a provider puts it', () => {
    const out = redact('GET https://api.example.com/files?access_token=ya29.secret&alt=media');

    assert.equal(String(out).includes('ya29.secret'), false);
    // The rest of the URL survives, or the line stops being useful.
    assert.match(String(out), /files\?access_token=\[redacted\]&alt=media/);
  });

  it('strips an Authorization header quoted into a message', () => {
    const out = redact('provider refused: Authorization: Bearer ya29.a0AfH6SM');
    assert.equal(String(out).includes('ya29.a0AfH6SM'), false);
  });

  it('strips an access key id out of an object store error', () => {
    const out = redact('SignatureDoesNotMatch for AKIAIOSFODNN7EXAMPLE');
    assert.equal(String(out).includes('AKIAIOSFODNN7EXAMPLE'), false);
  });

  it('redacts a one-time code, which is a password with a short life', () => {
    const out = redact({ email: 'me@example.com', otp: '481923' }) as Record<string, unknown>;
    assert.equal(out['otp'], '[redacted]');
  });

  it('keeps an error readable while cleaning its message', () => {
    const error = new Error('failed https://x.test/f?token=abc123');
    error.cause = new Error('inner');

    const out = redact(error) as Record<string, unknown>;

    assert.equal(out['name'], 'Error');
    assert.equal(String(out['message']).includes('abc123'), false);
    assert.equal((out['cause'] as Record<string, unknown>)['message'], 'inner');
  });

  it('does not hang on an object that points at itself', () => {
    // A logger that throws while logging turns a handled failure into a crash,
    // and a request object holds a reference back to itself.
    const loop: Record<string, unknown> = { name: 'x' };
    loop['self'] = loop;

    assert.doesNotThrow(() => redact(loop));
    assert.match(JSON.stringify(redact(loop)), /circular/);
  });

  it('stops rather than walking an arbitrarily deep object', () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 20; i += 1) deep = { deep };

    assert.match(JSON.stringify(redact(deep)), /\[deep\]/);
  });

  it('leaves ordinary values alone', () => {
    assert.deepEqual(redact({ count: 3, ok: true, path: '/Photos/beach.jpg', missing: null }), {
      count: 3,
      ok: true,
      path: '/Photos/beach.jpg',
      missing: null,
    });
  });
});
