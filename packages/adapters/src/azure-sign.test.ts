import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { signAzure } from './azure-sign.js';

const KEY = Buffer.from('a-test-account-key-of-some-length').toString('base64');

/** Rebuilds the signature from a string, so a test can assert on the string. */
function signatureOf(stringToSign: string): string {
  return createHmac('sha256', Buffer.from(KEY, 'base64')).update(stringToSign, 'utf8').digest('base64');
}

describe('Shared Key signing', () => {
  it('names the account in the scheme', () => {
    const auth = signAzure({
      method: 'GET',
      url: 'https://acct.blob.core.windows.net/photos/a.jpg',
      accountName: 'acct',
      accountKey: KEY,
      headers: { 'x-ms-date': 'Fri, 22 Aug 2026 10:00:00 GMT', 'x-ms-version': '2021-08-06' },
    });

    assert.match(auth, /^SharedKey acct:/);
  });

  it('signs the exact thirteen-line string Azure verifies', () => {
    /*
     * Positional and unforgiving: an empty line is not a missing line. Azure
     * counts them, so a dropped blank fails identically to a wrong value - and
     * that is the failure this test exists to catch.
     */
    const auth = signAzure({
      method: 'GET',
      url: 'https://acct.blob.core.windows.net/photos/a.jpg',
      accountName: 'acct',
      accountKey: KEY,
      headers: { 'x-ms-date': 'Fri, 22 Aug 2026 10:00:00 GMT', 'x-ms-version': '2021-08-06' },
    });

    const expected = [
      'GET',
      '', // content-encoding
      '', // content-language
      '', // content-length
      '', // content-md5
      '', // content-type
      '', // date - empty, because x-ms-date is used instead
      '', // if-modified-since
      '', // if-match
      '', // if-none-match
      '', // if-unmodified-since
      '', // range
      'x-ms-date:Fri, 22 Aug 2026 10:00:00 GMT\nx-ms-version:2021-08-06',
      '/acct/photos/a.jpg',
    ].join('\n');

    assert.equal(auth, `SharedKey acct:${signatureOf(expected)}`);
  });

  it('sorts the x-ms headers, because Azure signs them sorted', () => {
    const sorted = signAzure({
      method: 'GET',
      url: 'https://acct.blob.core.windows.net/c/a',
      accountName: 'acct',
      accountKey: KEY,
      headers: { 'x-ms-date': 'D', 'x-ms-version': 'V' },
    });

    const shuffled = signAzure({
      method: 'GET',
      url: 'https://acct.blob.core.windows.net/c/a',
      accountName: 'acct',
      accountKey: KEY,
      headers: { 'x-ms-version': 'V', 'x-ms-date': 'D' },
    });

    assert.equal(sorted, shuffled);
  });

  it('ignores headers that are not x-ms in the canonical block', () => {
    // They belong on the earlier positional lines or nowhere; including them
    // twice is a 403.
    const withExtra = signAzure({
      method: 'GET',
      url: 'https://acct.blob.core.windows.net/c/a',
      accountName: 'acct',
      accountKey: KEY,
      headers: { 'x-ms-date': 'D', accept: 'application/xml' },
    });

    const without = signAzure({
      method: 'GET',
      url: 'https://acct.blob.core.windows.net/c/a',
      accountName: 'acct',
      accountKey: KEY,
      headers: { 'x-ms-date': 'D' },
    });

    assert.equal(withExtra, without);
  });

  it('puts the query in the resource, lowercased and sorted', () => {
    const auth = signAzure({
      method: 'GET',
      url: 'https://acct.blob.core.windows.net/photos?restype=container&comp=list&Prefix=a%2F',
      accountName: 'acct',
      accountKey: KEY,
      headers: { 'x-ms-date': 'D' },
    });

    const expected = [
      'GET', '', '', '', '', '', '', '', '', '', '', '',
      'x-ms-date:D',
      '/acct/photos\ncomp:list\nprefix:a/\nrestype:container',
    ].join('\n');

    assert.equal(auth, `SharedKey acct:${signatureOf(expected)}`);
  });

  it('decodes the path, since Azure signs the decoded form', () => {
    // A file with a space signs against the space, not against %20.
    const auth = signAzure({
      method: 'GET',
      url: 'https://acct.blob.core.windows.net/photos/my%20file.jpg',
      accountName: 'acct',
      accountKey: KEY,
      headers: { 'x-ms-date': 'D' },
    });

    const expected = [
      'GET', '', '', '', '', '', '', '', '', '', '', '',
      'x-ms-date:D',
      '/acct/photos/my file.jpg',
    ].join('\n');

    assert.equal(auth, `SharedKey acct:${signatureOf(expected)}`);
  });

  it('leaves content-length blank for an empty body rather than writing 0', () => {
    // A literal 0 is rejected; the line has to be empty.
    const empty = signAzure({
      method: 'PUT',
      url: 'https://acct.blob.core.windows.net/c/a',
      accountName: 'acct',
      accountKey: KEY,
      headers: { 'x-ms-date': 'D' },
      contentLength: 0,
    });

    const absent = signAzure({
      method: 'PUT',
      url: 'https://acct.blob.core.windows.net/c/a',
      accountName: 'acct',
      accountKey: KEY,
      headers: { 'x-ms-date': 'D' },
    });

    assert.equal(empty, absent);
  });

  it('includes a range header, which is signed', () => {
    const ranged = signAzure({
      method: 'GET',
      url: 'https://acct.blob.core.windows.net/c/a',
      accountName: 'acct',
      accountKey: KEY,
      headers: { 'x-ms-date': 'D', range: 'bytes=0-99' },
    });

    const whole = signAzure({
      method: 'GET',
      url: 'https://acct.blob.core.windows.net/c/a',
      accountName: 'acct',
      accountKey: KEY,
      headers: { 'x-ms-date': 'D' },
    });

    assert.notEqual(ranged, whole, 'a signed header that is not in the signature is a 403');
  });
});
