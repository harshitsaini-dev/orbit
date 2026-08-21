import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeKey, encodeRfc3986, signRequest } from './sigv4.js';

/**
 * The first case is Amazon's own `get-vanilla` vector, credentials, clock and
 * all. Anchoring to a published signature is the only way to know the
 * implementation is right rather than merely self-consistent: a signer that is
 * wrong in the same way every time still agrees with itself. The rest check
 * properties that vector cannot reach - what is signed, and what canonical form
 * makes irrelevant.
 */
const CREDS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'service',
  now: new Date('2015-08-30T12:36:00Z'),
};

function authOf(headers: Record<string, string>): string {
  return headers['authorization'] ?? '';
}

describe('signRequest', () => {
  it('matches the published vector for a request with no query', () => {
    const { headers } = signRequest({
      ...CREDS,
      method: 'GET',
      url: 'https://example.amazonaws.com/',
    });

    assert.match(authOf(headers), /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request/);
    assert.match(
      authOf(headers),
      /Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31$/,
    );
  });

  it('canonicalises query order, so the same request signs the same way', () => {
    // The canonical form sorts by name and then by value, which means the order
    // the caller happened to build the URL in cannot change the signature.
    const a = signRequest({ ...CREDS, method: 'GET', url: 'https://example.amazonaws.com/?b=2&a=1' });
    const b = signRequest({ ...CREDS, method: 'GET', url: 'https://example.amazonaws.com/?a=1&b=2' });
    assert.equal(authOf(a.headers), authOf(b.headers));

    const dupA = signRequest({ ...CREDS, method: 'GET', url: 'https://example.amazonaws.com/?p=2&p=1' });
    const dupB = signRequest({ ...CREDS, method: 'GET', url: 'https://example.amazonaws.com/?p=1&p=2' });
    assert.equal(authOf(dupA.headers), authOf(dupB.headers));
  });

  it('signs the query string, so a tampered parameter is rejected', () => {
    const listed = signRequest({ ...CREDS, method: 'GET', url: 'https://example.amazonaws.com/?prefix=a' });
    const other = signRequest({ ...CREDS, method: 'GET', url: 'https://example.amazonaws.com/?prefix=b' });
    assert.notEqual(authOf(listed.headers), authOf(other.headers));
  });

  it('signs the headers it adds, and the host', () => {
    const { headers } = signRequest({
      ...CREDS,
      method: 'GET',
      url: 'https://example.amazonaws.com/',
    });

    assert.equal(headers['x-amz-date'], '20150830T123600Z');
    assert.match(authOf(headers), /SignedHeaders=host;x-amz-date/);
  });

  it('adds the content hash for S3, and only for S3', () => {
    const forS3 = signRequest({ ...CREDS, service: 's3', method: 'GET', url: 'https://b.example.com/' });
    // An empty body still has a hash, and S3 rejects the request without it.
    assert.equal(
      forS3.headers['x-amz-content-sha256'],
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );

    const other = signRequest({ ...CREDS, method: 'GET', url: 'https://b.example.com/' });
    assert.equal(other.headers['x-amz-content-sha256'], undefined);
  });

  it('includes a session token in the signature when one is supplied', () => {
    const withToken = signRequest({
      ...CREDS,
      method: 'GET',
      url: 'https://example.amazonaws.com/',
      sessionToken: 'temporary',
    });

    assert.equal(withToken.headers['x-amz-security-token'], 'temporary');
    assert.match(authOf(withToken.headers), /SignedHeaders=host;x-amz-date;x-amz-security-token/);
  });

  it('produces a different signature for a different payload', () => {
    const base = { ...CREDS, method: 'PUT', url: 'https://example.amazonaws.com/key' };
    const a = signRequest({ ...base, body: 'one' });
    const b = signRequest({ ...base, body: 'two' });

    // The body hash is part of the string to sign, which is what stops a signed
    // request being replayed with different content.
    assert.notEqual(authOf(a.headers), authOf(b.headers));
  });

  it('can leave a streamed payload unsigned', () => {
    const { headers } = signRequest({
      ...CREDS,
      service: 's3',
      method: 'PUT',
      url: 'https://example.amazonaws.com/key',
      body: 'UNSIGNED-PAYLOAD',
    });

    assert.equal(headers['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD');
  });
});

describe('encodeRfc3986', () => {
  it('encodes the characters encodeURIComponent leaves alone', () => {
    // These five are the whole reason this function exists: left unencoded they
    // produce a signature mismatch with no hint as to the cause.
    assert.equal(encodeRfc3986("!'()*"), '%21%27%28%29%2A');
  });

  it('leaves the unreserved set untouched', () => {
    assert.equal(encodeRfc3986('aZ09-._~'), 'aZ09-._~');
  });

  it('encodes a slash, which a key segment may contain', () => {
    assert.equal(encodeRfc3986('a/b'), 'a%2Fb');
  });
});

describe('encodeKey', () => {
  it('keeps separators but encodes everything between them', () => {
    assert.equal(encodeKey('holiday photos/day 1/a+b.jpg'), 'holiday%20photos/day%201/a%2Bb.jpg');
  });

  it('encodes a plus rather than letting it decode as a space', () => {
    // S3 keys take any byte, and a literal + in a key is not a space.
    assert.equal(encodeKey('a+b'), 'a%2Bb');
  });
});
