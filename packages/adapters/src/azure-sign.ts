import { createHmac } from 'node:crypto';

/**
 * Azure Storage Shared Key signing.
 *
 * Written out rather than pulled from the Azure SDK, for the same reasons
 * SigV4 is: the SDK is a large dependency for one signing algorithm, and the
 * algorithm itself is small and fully specified.
 *
 * It is not SigV4 with different names. The string to sign is a fixed sequence
 * of positional lines - thirteen of them, most usually empty - and getting the
 * count wrong fails in exactly the same way as getting a value wrong, which is
 * why the blanks are written out one per line here rather than joined from a
 * loop.
 */

export interface AzureSignInput {
  method: string;
  /** Absolute URL, including any query string. */
  url: string;
  accountName: string;
  /** The account key, base64 as Azure hands it out. */
  accountKey: string;
  /** Headers already set on the request, including the x-ms-* ones. */
  headers: Record<string, string>;
  /** Only for a request with a body; omitted means no `content-length` line. */
  contentLength?: number;
}

/**
 * The canonical headers block: every `x-ms-` header, lowercased, sorted, one
 * per line. Azure signs these, so a header added later that is not in the
 * signature is a 403 rather than an ignored header.
 */
function canonicalHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim()] as const)
    .filter(([name]) => name.startsWith('x-ms-'))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}:${value}`)
    .join('\n');
}

/**
 * The canonical resource: the account, the path, then each query parameter
 * lowercased and sorted, one per line.
 *
 * Repeated parameters are joined with commas - rare against Blob storage, but
 * omitting the rule means a request that uses one signs differently from the
 * one Azure verifies.
 */
function canonicalResource(accountName: string, url: URL): string {
  const grouped = new Map<string, string[]>();

  for (const [name, value] of url.searchParams) {
    const key = name.toLowerCase();
    grouped.set(key, [...(grouped.get(key) ?? []), value]);
  }

  const query = [...grouped.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, values]) => `${name}:${values.sort().join(',')}`)
    .join('\n');

  const resource = `/${accountName}${decodeURIComponent(url.pathname)}`;
  return query ? `${resource}\n${query}` : resource;
}

/** The `Authorization` value for one request. */
export function signAzure(input: AzureSignInput): string {
  const url = new URL(input.url);
  const headers = Object.fromEntries(
    Object.entries(input.headers).map(([name, value]) => [name.toLowerCase(), value]),
  );

  /*
   * Positional and unforgiving. An empty line is not a missing line: Azure
   * counts them, so each blank is written deliberately rather than skipped.
   *
   * `content-length` is the one exception to "empty means empty" - it is left
   * blank for a request with no body, and a literal 0 would be rejected.
   */
  const stringToSign = [
    input.method.toUpperCase(),
    headers['content-encoding'] ?? '',
    headers['content-language'] ?? '',
    input.contentLength === undefined || input.contentLength === 0
      ? ''
      : String(input.contentLength),
    headers['content-md5'] ?? '',
    headers['content-type'] ?? '',
    // Date is empty because x-ms-date is used instead, which is the documented
    // way round and the only one that survives a proxy rewriting Date.
    '',
    headers['if-modified-since'] ?? '',
    headers['if-match'] ?? '',
    headers['if-none-match'] ?? '',
    headers['if-unmodified-since'] ?? '',
    headers['range'] ?? '',
    canonicalHeaders(headers),
    canonicalResource(input.accountName, url),
  ].join('\n');

  const signature = createHmac('sha256', Buffer.from(input.accountKey, 'base64'))
    .update(stringToSign, 'utf8')
    .digest('base64');

  return `SharedKey ${input.accountName}:${signature}`;
}
