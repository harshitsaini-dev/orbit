import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, for every S3-compatible store.
 *
 * Written out rather than pulled from the AWS SDK: the SDK is tens of megabytes
 * of client code for one signing algorithm, it assumes AWS endpoint conventions
 * that R2, Backblaze and Supabase do not all share, and Orbit has to run inside
 * a free tier. The algorithm itself is small and fully specified, and the tests
 * check it against Amazon's own published vectors.
 */

export interface SignInput {
  method: string;
  /** Absolute URL including any query string. */
  url: string;
  region: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Session token for temporary credentials, when the store issues them. */
  sessionToken?: string | undefined;
  headers?: Record<string, string>;
  /** Raw body, or the literal 'UNSIGNED-PAYLOAD'. Defaults to an empty body. */
  body?: Uint8Array | string | undefined;
  /** Overrides the clock. Tests pin it; nothing else should. */
  now?: Date;
}

const UNSIGNED = 'UNSIGNED-PAYLOAD';

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * Percent-encoding as SigV4 defines it, which is not what encodeURIComponent
 * does: the unreserved set is exactly A-Z a-z 0-9 - . _ ~ and everything else
 * is encoded, including the characters JavaScript leaves alone. A key
 * containing `!` or `*` signs wrong under the built-in and the request is
 * rejected with a signature mismatch that says nothing about why.
 */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encodes an object key for a URL path, leaving the separators as separators. */
export function encodeKey(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/');
}

/** ISO 8601 basic format: 20260821T124512Z. */
function amzDate(now: Date): { full: string; day: string } {
  const full = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { full, day: full.slice(0, 8) };
}

/**
 * The canonical query string: parameters sorted by encoded name, then by
 * encoded value, each encoded with the same rules as the path.
 */
function canonicalQuery(url: URL): string {
  const pairs: Array<[string, string]> = [];
  url.searchParams.forEach((value, name) => {
    pairs.push([encodeRfc3986(name), encodeRfc3986(value)]);
  });

  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([name, value]) => `${name}=${value}`).join('&');
}

export interface SignedRequest {
  headers: Record<string, string>;
}

/**
 * Signs a request, returning the headers to send with it.
 *
 * The caller's headers are returned alongside the ones signing adds, so the
 * result can be handed straight to fetch.
 */
export function signRequest(input: SignInput): SignedRequest {
  const service = input.service ?? 's3';
  const url = new URL(input.url);
  const { full, day } = amzDate(input.now ?? new Date());

  const payloadHash =
    input.body === UNSIGNED ? UNSIGNED : sha256Hex(input.body === undefined ? '' : input.body);

  // Header names are compared and sorted lower-cased, and the host header is
  // always signed - it is what ties a signature to one endpoint.
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers[name.toLowerCase()] = value.trim();
  }
  headers['host'] = url.host;
  headers['x-amz-date'] = full;
  // S3 only. It is an S3 extension, not part of SigV4 itself, and sending it to
  // another service changes SignedHeaders for no reason.
  if (service === 's3') headers['x-amz-content-sha256'] = payloadHash;
  if (input.sessionToken) headers['x-amz-security-token'] = input.sessionToken;

  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((name) => `${name}:${headers[name]}\n`).join('');
  const signedHeaders = signedNames.join(';');

  // The path is already encoded in the URL; re-encoding it would double the
  // escapes on any key containing a space or a plus.
  const canonicalRequest = [
    input.method.toUpperCase(),
    url.pathname || '/',
    canonicalQuery(url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', full, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), service),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  headers['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { headers };
}

export { UNSIGNED };
