import { categorise } from '@orbit/shared-types';
import type {
  AccountTokens,
  AuthType,
  BulkResult,
  ByteRange,
  ConnectInput,
  DeltaResult,
  FileStreamResult,
  OrbitFile,
  OrbitFilePage,
  ProviderId,
  Quota,
  SearchQuery,
  UploadMeta,
  UploadSession,
} from '@orbit/shared-types';
import { BaseAdapter, joinPath, normalisePath, ProviderError, type AdapterCapabilities } from '../base.js';
import { providerFetch } from '../http.js';
import { encodeKey, signRequest, UNSIGNED } from '../sigv4.js';
import { eachTag, firstTag, parseS3Error } from '../xml.js';

/**
 * One adapter for every S3-compatible store: Amazon S3 itself, Cloudflare R2,
 * Supabase Storage, DigitalOcean Spaces, Backblaze B2 and anything else that
 * speaks the same API. They differ in endpoint and addressing style, which the
 * catalogue supplies, and not in the protocol.
 *
 * The gap to bridge is that an object store has no folders, no rename, no
 * search and no notion of a file being starred. Keys are flat strings that
 * happen to contain slashes. Orbit presents folders anyway, because a bucket
 * with ten thousand keys is unusable otherwise, and the illusion is built from
 * the delimiter the API already offers rather than from anything stored.
 */

/** Parts below this are rejected by S3, except the final one. */
const MIN_PART_BYTES = 5 * 1024 * 1024;
const CHUNK_SIZE = 8 * 1024 * 1024;

/** A bucket can hold more objects than it is reasonable to count. */
const MAX_QUOTA_PAGES = 50;
const PAGE_SIZE = 1000;

interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

interface ListPage {
  files: OrbitFile[];
  nextPageToken: string | undefined;
}

export class S3CompatibleAdapter extends BaseAdapter {
  readonly id: ProviderId = 's3';
  readonly authType: AuthType = 'access_key';
  readonly displayName = 'S3-compatible';
  readonly capabilities: AdapterCapabilities = {
    star: false,
    sharedWithMe: false,
    delta: false,
    resumableUpload: true,
    rangeRequests: true,
    nativeFolders: false,
    thumbnails: false,
    // The store has no search endpoint, but the adapter can still answer a
    // search by narrowing with a key prefix and matching names as it pages.
    // What this gates is whether a search is possible at all; false would make
    // every bucket silently unsearchable.
    search: true,
    fullTextSearch: false,
    recentView: false,
    flatEnumeration: true,
    reportsQuota: false,
  };

  // --- connection ---------------------------------------------------------

  override async connect(input: ConnectInput): Promise<AccountTokens> {
    if (input.kind !== 'credentials') {
      throw new ProviderError(this.id, 400, 'S3-compatible storage connects with an access key');
    }

    const values = input.values;
    if (!values.accessKeyId || !values.secretAccessKey || !values.endpoint || !values.bucket) {
      throw new ProviderError(
        this.id,
        400,
        'An access key, a secret, an endpoint and a bucket are all required',
      );
    }

    const tokens: AccountTokens = {
      accessKeyId: values.accessKeyId,
      secretAccessKey: values.secretAccessKey,
      endpoint: values.endpoint,
      // "auto" is what R2 expects and what every store that ignores the region
      // tolerates, so it is the safest thing to sign with when none is given.
      region: values.region ?? 'auto',
      bucket: values.bucket,
      forcePathStyle: values.forcePathStyle ?? false,
    };

    // Prove the credentials before storing them. A key that cannot list is a
    // connection that will fail on first use, and failing here says so while
    // the user is still looking at the form.
    await this.listObjects(tokens, { prefix: '', delimiter: '/', maxKeys: 1 });

    return tokens;
  }

  /** Access keys do not expire, so there is nothing to refresh. */
  override async refreshToken(tokens: AccountTokens): Promise<AccountTokens> {
    return tokens;
  }

  // --- reading ------------------------------------------------------------

  override async listFolder(
    tokens: AccountTokens,
    path: string,
    pageToken?: string,
  ): Promise<OrbitFilePage> {
    const prefix = prefixFor(path);
    const page = await this.listObjects(tokens, {
      prefix,
      delimiter: '/',
      continuationToken: pageToken,
    });

    return { files: page.files, ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) };
  }

  override async listAllFiles(tokens: AccountTokens, pageToken?: string): Promise<OrbitFilePage> {
    // No delimiter: every key in one flat sequence, which is what the storage
    // breakdown and the sync engine want.
    const page = await this.listObjects(tokens, { prefix: '', continuationToken: pageToken });
    return { files: page.files, ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) };
  }

  /**
   * Search by paging with a prefix and matching as it goes.
   *
   * `underPath` narrows at the store, which is the only part it can do itself.
   * Everything else is decided here, so that a query means the same thing
   * against a bucket as against Drive.
   */
  override async search(
    tokens: AccountTokens,
    query: SearchQuery,
    pageToken?: string,
  ): Promise<OrbitFilePage> {
    const page = await this.listObjects(tokens, {
      prefix: query.underPath ? prefixFor(query.underPath) : '',
      continuationToken: pageToken,
    });

    const text = query.text?.toLowerCase();
    const files = page.files.filter((file) => {
      if (text && !file.name.toLowerCase().includes(text)) return false;
      if (query.minSizeBytes !== undefined && file.sizeBytes < query.minSizeBytes) return false;
      if (query.maxSizeBytes !== undefined && file.sizeBytes > query.maxSizeBytes) return false;
      if (query.modifiedAfter && file.modifiedAt < query.modifiedAfter) return false;
      // Nothing in a bucket is starred, so a starred-only search matches nothing
      // rather than everything.
      if (query.starredOnly) return false;
      return true;
    });

    return { files, ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) };
  }

  override async getFileMeta(tokens: AccountTokens, remoteId: string): Promise<OrbitFile> {
    const response = await this.request(tokens, { method: 'HEAD', key: remoteId });

    return objectToFile(
      remoteId,
      Number(response.headers.get('content-length') ?? 0),
      response.headers.get('last-modified') ?? new Date().toISOString(),
      response.headers.get('etag') ?? undefined,
    );
  }

  override async getFileStream(
    tokens: AccountTokens,
    remoteId: string,
    range?: ByteRange,
  ): Promise<FileStreamResult> {
    const headers: Record<string, string> = {};
    if (range) {
      headers['range'] = `bytes=${range.start}-${range.end ?? ''}`;
    }

    const response = await this.request(tokens, { method: 'GET', key: remoteId, headers });
    if (!response.body) throw new ProviderError(this.id, 502, 'The store returned no body');

    const contentRange = response.headers.get('content-range');
    const contentLength = response.headers.get('content-length');

    return {
      stream: response.body,
      contentType:
        response.headers.get('content-type') ?? categoryMime(remoteId),
      ...(contentLength ? { contentLength: Number(contentLength) } : {}),
      ...(contentRange ? { contentRange } : {}),
    };
  }

  // --- writing ------------------------------------------------------------

  /**
   * Folders do not exist, so this writes the marker object that every S3 client
   * uses to stand for one: an empty key ending in a slash. Without it a new
   * folder would vanish the moment it was created, having nothing in it.
   */
  override async createFolder(tokens: AccountTokens, path: string, name: string): Promise<OrbitFile> {
    const virtualPath = joinPath(path, name);
    const key = `${prefixFor(virtualPath)}`;

    await this.request(tokens, {
      method: 'PUT',
      key,
      headers: { 'content-length': '0' },
      body: new Uint8Array(),
    });

    return {
      remoteId: key,
      name,
      virtualPath,
      mimeType: 'application/x-directory',
      sizeBytes: 0,
      isFolder: true,
      starred: false,
      modifiedAt: new Date().toISOString(),
    };
  }

  /**
   * There is no rename in S3, so this is a copy followed by a delete - and for a
   * folder, that has to happen for every key beneath it. A partial failure
   * would leave a folder half under each name, so the deletes only run once
   * every copy has succeeded.
   */
  override async rename(tokens: AccountTokens, remoteId: string, newName: string): Promise<void> {
    const isFolder = remoteId.endsWith('/');
    const parent = parentPrefix(remoteId);
    const target = isFolder ? `${parent}${newName}/` : `${parent}${newName}`;

    if (target === remoteId) return;

    const sources = isFolder ? await this.allKeysUnder(tokens, remoteId) : [remoteId];
    const moves = sources.map((source) => ({ source, target: target + source.slice(remoteId.length) }));

    for (const move of moves) {
      await this.copyObject(tokens, move.source, move.target);
    }
    for (const move of moves) {
      await this.request(tokens, { method: 'DELETE', key: move.source });
    }
  }

  override async remove(tokens: AccountTokens, remoteIds: string[]): Promise<BulkResult> {
    const result: BulkResult = { succeeded: [], failed: [] };

    for (const remoteId of remoteIds) {
      try {
        // Deleting a folder means deleting everything under its prefix; the
        // marker object alone would leave the contents orphaned and invisible.
        const keys = remoteId.endsWith('/') ? await this.allKeysUnder(tokens, remoteId) : [remoteId];
        for (const key of keys) {
          await this.request(tokens, { method: 'DELETE', key });
        }
        result.succeeded.push(remoteId);
      } catch (err) {
        result.failed.push({
          remoteId,
          reason: err instanceof Error ? err.message : 'Delete failed',
        });
      }
    }

    return result;
  }

  // --- upload -------------------------------------------------------------

  override async initUpload(
    tokens: AccountTokens,
    path: string,
    meta: UploadMeta,
  ): Promise<UploadSession> {
    const virtualPath = joinPath(path, meta.name);
    const key = virtualPath.slice(1);

    const response = await this.request(tokens, {
      method: 'POST',
      key,
      query: { uploads: '' },
      headers: { 'content-type': meta.mimeType },
    });

    const xml = await response.text();
    const uploadId = firstTag(xml, 'UploadId');
    if (!uploadId) throw new ProviderError(this.id, 502, 'The store did not return an upload id');

    return {
      provider: this.id,
      remoteSessionId: uploadId,
      chunkSize: CHUNK_SIZE,
      state: {
        key,
        uploadId,
        virtualPath,
        uploaded: 0,
        totalBytes: meta.sizeBytes,
        partNumber: 0,
        parts: [] as Array<{ partNumber: number; etag: string }>,
        tokens,
      },
    };
  }

  override async uploadChunk(
    session: UploadSession,
    chunk: Uint8Array,
    onProgress: (uploadedBytes: number) => void,
  ): Promise<{ done: boolean; file?: OrbitFile }> {
    const state = session.state as {
      key: string;
      uploadId: string;
      virtualPath: string;
      uploaded: number;
      totalBytes: number;
      partNumber: number;
      parts: Array<{ partNumber: number; etag: string }>;
      tokens: AccountTokens;
    };

    state.partNumber += 1;

    // Every part but the last must reach the minimum, and a store that rejects
    // one mid-upload gives an error that does not name the cause.
    const isFinalPart = state.uploaded + chunk.byteLength >= state.totalBytes;
    if (!isFinalPart && chunk.byteLength < MIN_PART_BYTES) {
      throw new ProviderError(
        this.id,
        400,
        `Multipart parts must be at least ${MIN_PART_BYTES} bytes except the last`,
      );
    }

    const response = await this.request(state.tokens, {
      method: 'PUT',
      key: state.key,
      query: { partNumber: String(state.partNumber), uploadId: state.uploadId },
      body: chunk,
    });

    const etag = response.headers.get('etag');
    if (!etag) throw new ProviderError(this.id, 502, 'The store did not acknowledge the part');

    state.parts.push({ partNumber: state.partNumber, etag });
    state.uploaded += chunk.byteLength;
    onProgress(state.uploaded);

    if (!isFinalPart) return { done: false };

    const body = `<CompleteMultipartUpload>${state.parts
      .map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag}</ETag></Part>`)
      .join('')}</CompleteMultipartUpload>`;

    await this.request(state.tokens, {
      method: 'POST',
      key: state.key,
      query: { uploadId: state.uploadId },
      headers: { 'content-type': 'application/xml' },
      body,
    });

    return {
      done: true,
      file: objectToFile(state.key, state.totalBytes, new Date().toISOString()),
    };
  }

  // --- account ------------------------------------------------------------

  /**
   * A bucket has no allowance to report, so only the bytes used are real - and
   * counting those means walking every key. The walk is capped: past the cap
   * the figure is a floor rather than a total, which is the honest thing a
   * usage bar can show for a store that will not answer the question itself.
   */
  override async getQuota(tokens: AccountTokens): Promise<Quota> {
    let usedBytes = 0;
    let token: string | undefined;

    for (let page = 0; page < MAX_QUOTA_PAGES; page += 1) {
      const result = await this.listObjects(tokens, { prefix: '', continuationToken: token });
      for (const file of result.files) usedBytes += file.sizeBytes;
      if (!result.nextPageToken) break;
      token = result.nextPageToken;
    }

    return { usedBytes, totalBytes: 0 };
  }

  override async listChangesSince(_tokens: AccountTokens, _cursor: string | null): Promise<DeltaResult> {
    // S3 has no change feed; the sync engine falls back to flat enumeration,
    // which `flatEnumeration` advertises.
    return this.unsupported('listChangesSince');
  }

  // --- plumbing -----------------------------------------------------------

  private config(tokens: AccountTokens): S3Config {
    const { accessKeyId, secretAccessKey, endpoint, bucket } = tokens;
    if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) {
      throw new ProviderError(this.id, 400, 'This connection is missing its endpoint or credentials');
    }

    return {
      accessKeyId,
      secretAccessKey,
      endpoint,
      bucket,
      region: tokens.region ?? 'auto',
      forcePathStyle: tokens.forcePathStyle ?? false,
    };
  }

  /**
   * Path-style puts the bucket in the path, virtual-hosted puts it in the
   * hostname. R2 and Supabase want one, Amazon prefers the other, and a store
   * given the wrong shape answers with a signature error rather than saying so.
   */
  private baseUrl(config: S3Config): string {
    const endpoint = new URL(config.endpoint);
    if (config.forcePathStyle) {
      return `${endpoint.origin}${endpoint.pathname.replace(/\/$/, '')}/${encodeKey(config.bucket)}`;
    }
    return `${endpoint.protocol}//${config.bucket}.${endpoint.host}`;
  }

  private async request(
    tokens: AccountTokens,
    options: {
      method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD';
      key?: string;
      query?: Record<string, string>;
      headers?: Record<string, string>;
      body?: Uint8Array | string;
    },
  ): Promise<Response> {
    const config = this.config(tokens);
    // No trailing slash when there is no key: path-style addressing already
    // ends in the bucket, and `/bucket/` is a different resource to some stores
    // than `/bucket`.
    const url = new URL(`${this.baseUrl(config)}${options.key ? `/${encodeKey(options.key)}` : ''}`);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(name, value);
    }

    const { headers } = signRequest({
      method: options.method,
      url: url.toString(),
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      headers: options.headers ?? {},
      body: options.body,
    });

    const response = await providerFetch(this.id, url.toString(), {
      method: options.method,
      headers,
      ...(options.body === undefined ? {} : { body: options.body as BodyInit }),
    });

    return response;
  }

  private async listObjects(
    tokens: AccountTokens,
    options: { prefix: string; delimiter?: string; continuationToken?: string | undefined; maxKeys?: number },
  ): Promise<ListPage> {
    const query: Record<string, string> = {
      'list-type': '2',
      'max-keys': String(options.maxKeys ?? PAGE_SIZE),
      // Keys may hold any byte, including ones that are not valid XML text.
      // Asking for them URL-encoded removes the ambiguity entirely.
      'encoding-type': 'url',
    };
    if (options.prefix) query['prefix'] = options.prefix;
    if (options.delimiter) query['delimiter'] = options.delimiter;
    if (options.continuationToken) query['continuation-token'] = options.continuationToken;

    const response = await this.request(tokens, { method: 'GET', query });
    const xml = await response.text();

    const files: OrbitFile[] = [];

    // CommonPrefixes are the folders: keys sharing everything up to the next
    // delimiter, collapsed by the store into one entry.
    for (const block of eachTag(xml, 'CommonPrefixes')) {
      const raw = firstTag(block, 'Prefix');
      if (!raw) continue;
      const prefix = decodeURIComponent(raw);
      files.push(prefixToFolder(prefix));
    }

    for (const block of eachTag(xml, 'Contents')) {
      const raw = firstTag(block, 'Key');
      if (!raw) continue;
      const key = decodeURIComponent(raw);

      // The marker object standing for a folder is an implementation detail;
      // showing it would put an empty zero-byte file beside every folder.
      if (key.endsWith('/')) continue;

      files.push(
        objectToFile(
          key,
          Number(firstTag(block, 'Size') ?? 0),
          firstTag(block, 'LastModified') ?? new Date().toISOString(),
          firstTag(block, 'ETag'),
        ),
      );
    }

    const truncated = firstTag(xml, 'IsTruncated') === 'true';
    const next = firstTag(xml, 'NextContinuationToken');

    return { files, nextPageToken: truncated && next ? decodeURIComponent(next) : undefined };
  }

  /** Every key beneath a prefix, marker object included. */
  private async allKeysUnder(tokens: AccountTokens, prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;

    do {
      const response = await this.request(tokens, {
        method: 'GET',
        query: {
          'list-type': '2',
          prefix,
          'max-keys': String(PAGE_SIZE),
          'encoding-type': 'url',
          ...(token ? { 'continuation-token': token } : {}),
        },
      });
      const xml = await response.text();

      for (const block of eachTag(xml, 'Contents')) {
        const raw = firstTag(block, 'Key');
        if (raw) keys.push(decodeURIComponent(raw));
      }

      const next = firstTag(xml, 'NextContinuationToken');
      token = firstTag(xml, 'IsTruncated') === 'true' && next ? decodeURIComponent(next) : undefined;
    } while (token);

    return keys;
  }

  private async copyObject(tokens: AccountTokens, source: string, target: string): Promise<void> {
    const config = this.config(tokens);

    const response = await this.request(tokens, {
      method: 'PUT',
      key: target,
      headers: { 'x-amz-copy-source': `/${config.bucket}/${encodeKey(source)}` },
    });

    // A copy can fail inside a 200 response: S3 streams the body while the copy
    // runs and puts the error in it, so the status is sent before the outcome
    // is known. Trusting the status alone would silently lose the object.
    const xml = await response.text();
    if (xml.includes('<Error')) {
      const error = parseS3Error(xml);
      throw new ProviderError(this.id, 502, error.message ?? 'Copy failed');
    }
  }
}

// --- mapping --------------------------------------------------------------

/** The key prefix a virtual path corresponds to: "/a/b" becomes "a/b/". */
function prefixFor(path: string): string {
  const normalised = normalisePath(path);
  return normalised === '/' ? '' : `${normalised.slice(1)}/`;
}

function parentPrefix(key: string): string {
  const trimmed = key.endsWith('/') ? key.slice(0, -1) : key;
  const cut = trimmed.lastIndexOf('/');
  return cut === -1 ? '' : trimmed.slice(0, cut + 1);
}

function prefixToFolder(prefix: string): OrbitFile {
  const trimmed = prefix.replace(/\/$/, '');
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1);

  return {
    remoteId: prefix,
    name,
    virtualPath: `/${trimmed}`,
    mimeType: 'application/x-directory',
    sizeBytes: 0,
    isFolder: true,
    starred: false,
    // A prefix has no timestamp of its own; it is not stored anywhere.
    modifiedAt: new Date(0).toISOString(),
  };
}

function objectToFile(key: string, sizeBytes: number, modifiedAt: string, etag?: string): OrbitFile {
  const name = key.slice(key.lastIndexOf('/') + 1);
  const file: OrbitFile = {
    remoteId: key,
    name,
    virtualPath: `/${key}`,
    mimeType: categoryMime(key),
    sizeBytes,
    isFolder: false,
    starred: false,
    modifiedAt: new Date(modifiedAt).toISOString(),
  };

  // ETags come quoted, and for a multipart object they are not an MD5 at all -
  // they end in "-<partcount>". Passing that off as a checksum would make an
  // integrity check fail on every large file.
  const cleaned = etag?.replace(/"/g, '');
  if (cleaned && !cleaned.includes('-')) file.checksum = cleaned;

  return file;
}

/**
 * Object stores keep a content type but do not return it when listing, so the
 * listing infers one from the name. The stored type still wins on download,
 * where the store does send it.
 */
function categoryMime(key: string): string {
  const category = categorise(undefined, key);
  const extension = key.slice(key.lastIndexOf('.') + 1).toLowerCase();

  const known: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    pdf: 'application/pdf',
    json: 'application/json',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    zip: 'application/zip',
  };

  if (known[extension]) return known[extension]!;
  if (category === 'code') return 'text/plain';
  return 'application/octet-stream';
}

export { UNSIGNED };
