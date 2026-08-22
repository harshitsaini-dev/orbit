import type {
  AccountTokens,
  AuthType,
  BulkResult,
  ByteRange,
  ConnectInput,
  FileStreamResult,
  OrbitFile,
  OrbitFilePage,
  ProviderId,
  Quota,
  UploadMeta,
  UploadSession,
} from '@orbit/shared-types';
import { mimeForName } from '@orbit/shared-types';
import { signAzure } from '../azure-sign.js';
import { BaseAdapter, joinPath, normalisePath, ProviderError, type AdapterCapabilities } from '../base.js';
import { providerFetch } from '../http.js';
import { decodeXmlText, eachTag, firstTag } from '../xml.js';

/**
 * Azure Blob Storage: one container, addressed as a drive.
 *
 * Close enough to S3 in shape to feel familiar and different enough in detail
 * to have needed its own adapter: Shared Key signing rather than SigV4, blocks
 * rather than multipart parts, and a listing that returns virtual directories
 * only when asked with a delimiter.
 *
 * Like every object store it has no real folders, no bin, and no thumbnails -
 * Orbit renders its own for images - so a delete here is final and the UI says
 * so rather than offering a way back that does not exist.
 */

/** The version whose semantics this is written against. */
const API_VERSION = '2021-08-06';

/** Azure's own cap is 4 MiB for a block via Put Block; this stays under it. */
const BLOCK_SIZE = 4 * 1024 * 1024;

export class AzureBlobAdapter extends BaseAdapter {
  readonly id: ProviderId = 'azure_blob';
  readonly authType: AuthType = 'access_key';
  readonly displayName = 'Azure Blob Storage';
  readonly capabilities: AdapterCapabilities = {
    star: false,
    sharedWithMe: false,
    delta: false,
    /** Blocks are staged and committed, which is a resumable upload. */
    resumableUpload: true,
    rangeRequests: true,
    /** Folders are a fiction over blob names, as in every object store. */
    nativeFolders: false,
    trash: false,
    purgeTrash: false,
    /** Copy Blob is server-side, so neither a move nor a copy moves bytes. */
    relocate: true,
    thumbnails: false,
    search: false,
    fullTextSearch: false,
    recentView: false,
    flatEnumeration: true,
    /** A container is billed by what is in it; there is no allowance. */
    reportsQuota: false,
  };

  override async connect(input: ConnectInput): Promise<AccountTokens> {
    if (input.kind !== 'credentials') {
      throw new ProviderError(this.id, 400, 'Azure Blob Storage connects with an account key');
    }

    const { azureAccountName, azureAccountKey, azureContainer } = input.values;
    if (!azureAccountName || !azureAccountKey || !azureContainer) {
      throw new ProviderError(
        this.id,
        400,
        'A storage account, its key and a container are all required',
      );
    }

    const tokens: AccountTokens = { azureAccountName, azureAccountKey, azureContainer };

    // Proved before it is stored: a wrong key saved silently becomes a
    // connection that fails later for no visible reason.
    await this.listFolder(tokens, '/');
    return tokens;
  }

  override async refreshToken(tokens: AccountTokens): Promise<AccountTokens> {
    // An account key does not expire.
    return tokens;
  }

  override async getQuota(): Promise<Quota> {
    // Azure reports none for a container, and inventing one is worse.
    return { usedBytes: 0, totalBytes: 0 };
  }

  override async listFolder(
    tokens: AccountTokens,
    path: string,
    pageToken?: string,
  ): Promise<OrbitFilePage> {
    const prefix = prefixFor(path);

    // The delimiter is what turns a flat namespace into folders: without it
    // Azure returns every blob under the prefix, however deep.
    const query = new URLSearchParams({
      restype: 'container',
      comp: 'list',
      delimiter: '/',
      maxresults: '200',
    });
    if (prefix) query.set('prefix', prefix);
    if (pageToken) query.set('marker', pageToken);

    const xml = await this.request(tokens, { method: 'GET', query });

    const folders = eachTag(xml, 'BlobPrefix')
      .map((entry) => firstTag(entry, 'Name'))
      .filter((name): name is string => Boolean(name))
      .map((name) => prefixToFolder(decodeXmlText(name)));

    const files = eachTag(xml, 'Blob')
      .map((entry) => azureToOrbitFile(entry))
      .filter((file): file is OrbitFile => file !== null)
      // The marker Orbit writes so an empty folder exists is its own
      // bookkeeping and has no business being listed back.
      .filter((file) => !file.name.startsWith('.orbit-folder'));

    const marker = firstTag(xml, 'NextMarker');

    return {
      files: [...folders, ...files],
      ...(marker ? { nextPageToken: decodeXmlText(marker) } : {}),
    };
  }

  override async listAllFiles(
    tokens: AccountTokens,
    pageToken?: string,
  ): Promise<OrbitFilePage> {
    // No delimiter: every blob in the container, which is what the storage
    // breakdown and the duplicate finder read.
    const query = new URLSearchParams({
      restype: 'container',
      comp: 'list',
      maxresults: '1000',
    });
    if (pageToken) query.set('marker', pageToken);

    const xml = await this.request(tokens, { method: 'GET', query });

    const files = eachTag(xml, 'Blob')
      .map((entry) => azureToOrbitFile(entry))
      .filter((file): file is OrbitFile => file !== null && !file.name.startsWith('.orbit-folder'));

    const marker = firstTag(xml, 'NextMarker');

    return { files, ...(marker ? { nextPageToken: decodeXmlText(marker) } : {}) };
  }

  override async getFileMeta(tokens: AccountTokens, remoteId: string): Promise<OrbitFile> {
    const response = await this.raw(tokens, { method: 'HEAD', key: remoteId });

    const name = remoteId.slice(remoteId.lastIndexOf('/') + 1);
    const modified = response.headers.get('last-modified');
    const etag = response.headers.get('etag');

    const file: OrbitFile = {
      remoteId,
      name,
      virtualPath: `/${remoteId}`,
      mimeType: response.headers.get('content-type') || mimeForName(name),
      sizeBytes: Number(response.headers.get('content-length') ?? 0),
      isFolder: false,
      starred: false,
      modifiedAt: modified ? new Date(modified).toISOString() : new Date(0).toISOString(),
    };

    /*
     * Deliberately no checksum from the ETag.
     *
     * Azure's ETag is an opaque token rather than a content hash, so using it
     * would have the duplicate finder call two identical files different - or
     * worse, two different files the same. The MD5 Azure reports separately is
     * comparable, and the listing picks that up.
     */
    void etag;

    return file;
  }

  override async getFileStream(
    tokens: AccountTokens,
    remoteId: string,
    range?: ByteRange,
  ): Promise<FileStreamResult> {
    const headers: Record<string, string> = {};
    if (range) headers['range'] = `bytes=${range.start}-${range.end ?? ''}`;

    const response = await this.raw(tokens, { method: 'GET', key: remoteId, headers });
    if (!response.body) throw new ProviderError(this.id, 502, 'No body in the response');

    const length = response.headers.get('content-length');

    return {
      stream: response.body,
      contentType: response.headers.get('content-type') ?? mimeForName(remoteId),
      ...(length ? { contentLength: Number(length) } : {}),
    };
  }

  override async getThumbnail(): Promise<FileStreamResult | null> {
    // Azure makes none. Orbit renders its own for images.
    return null;
  }

  override async createFolder(
    tokens: AccountTokens,
    path: string,
    name: string,
  ): Promise<OrbitFile> {
    // A folder exists because a blob's name has that prefix. An empty marker
    // gives Orbit something to list until a real file arrives.
    const prefix = `${prefixFor(joinPath(normalisePath(path), name))}`;

    await this.raw(tokens, {
      method: 'PUT',
      key: `${prefix}.orbit-folder`,
      headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': 'application/octet-stream' },
      body: new Uint8Array(0),
    });

    return prefixToFolder(prefix);
  }

  override async rename(
    tokens: AccountTokens,
    remoteId: string,
    newName: string,
  ): Promise<void> {
    const parent = remoteId.slice(0, remoteId.lastIndexOf('/') + 1);
    await this.relocateKey(tokens, remoteId, `${parent}${newName}`, { copy: false });
  }

  override async relocate(
    tokens: AccountTokens,
    remoteId: string,
    targetPath: string,
    options: { copy: boolean },
  ): Promise<OrbitFile> {
    const name = remoteId.slice(remoteId.lastIndexOf('/') + 1);
    const target = `${prefixFor(targetPath)}${name}`;

    if (target === remoteId) return this.getFileMeta(tokens, remoteId);

    await this.relocateKey(tokens, remoteId, target, options);
    return this.getFileMeta(tokens, target);
  }

  override async remove(tokens: AccountTokens, remoteIds: string[]): Promise<BulkResult> {
    const result: BulkResult = { succeeded: [], failed: [] };

    for (const remoteId of remoteIds) {
      try {
        // A folder is a prefix, so removing one means removing every blob
        // under it - the marker alone would orphan the contents.
        const keys = remoteId.endsWith('/') ? await this.keysUnder(tokens, remoteId) : [remoteId];
        for (const key of keys) await this.raw(tokens, { method: 'DELETE', key });

        result.succeeded.push(remoteId);
      } catch (err) {
        result.failed.push({
          remoteId,
          reason: err instanceof Error ? err.message : 'could not be deleted',
        });
      }
    }

    return result;
  }

  override async star(): Promise<void> {
    throw new ProviderError(this.id, 501, 'Azure Blob Storage has no concept of starring');
  }

  override async initUpload(
    tokens: AccountTokens,
    path: string,
    meta: UploadMeta,
  ): Promise<UploadSession> {
    const key = `${prefixFor(path)}${meta.name}`;

    return {
      provider: this.id,
      remoteSessionId: key,
      chunkSize: BLOCK_SIZE,
      state: {
        key,
        tokens,
        mimeType: meta.mimeType,
        totalBytes: meta.sizeBytes,
        uploaded: 0,
        // Block ids must be the same length for every block in one blob, and
        // base64. A fixed-width number padded then encoded satisfies both.
        blockIds: [] as string[],
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
      tokens: AccountTokens;
      mimeType: string;
      totalBytes: number;
      uploaded: number;
      blockIds: string[];
    };

    const blockId = Buffer.from(String(state.blockIds.length).padStart(8, '0')).toString('base64');
    state.blockIds.push(blockId);

    await this.raw(state.tokens, {
      method: 'PUT',
      key: state.key,
      query: new URLSearchParams({ comp: 'block', blockid: blockId }),
      headers: { 'content-type': 'application/octet-stream' },
      body: chunk,
    });

    state.uploaded += chunk.byteLength;
    onProgress(state.uploaded);

    if (state.uploaded < state.totalBytes) return { done: false };

    // Committed in the order they were staged. Azure keeps uncommitted blocks
    // for a week and then discards them, so an abandoned upload costs nothing.
    const list = `<?xml version="1.0" encoding="utf-8"?><BlockList>${state.blockIds
      .map((id) => `<Latest>${id}</Latest>`)
      .join('')}</BlockList>`;

    await this.raw(state.tokens, {
      method: 'PUT',
      key: state.key,
      query: new URLSearchParams({ comp: 'blocklist' }),
      headers: {
        'content-type': 'application/xml',
        'x-ms-blob-content-type': state.mimeType || mimeForName(state.key),
      },
      body: new TextEncoder().encode(list),
    });

    return { done: true, file: await this.getFileMeta(state.tokens, state.key) };
  }

  // --- plumbing -------------------------------------------------------------

  /** Copy Blob, then delete the source for a move. Server-side either way. */
  private async relocateKey(
    tokens: AccountTokens,
    from: string,
    to: string,
    options: { copy: boolean },
  ): Promise<void> {
    await this.raw(tokens, {
      method: 'PUT',
      key: to,
      headers: { 'x-ms-copy-source': this.url(tokens, from).toString() },
    });

    if (!options.copy) await this.raw(tokens, { method: 'DELETE', key: from });
  }

  private async keysUnder(tokens: AccountTokens, prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let marker: string | undefined;

    do {
      const query = new URLSearchParams({
        restype: 'container',
        comp: 'list',
        prefix,
        maxresults: '1000',
      });
      if (marker) query.set('marker', marker);

      const xml = await this.request(tokens, { method: 'GET', query });

      for (const entry of eachTag(xml, 'Blob')) {
        const name = firstTag(entry, 'Name');
        if (name) keys.push(decodeXmlText(name));
      }

      marker = firstTag(xml, 'NextMarker');
      if (marker) marker = decodeXmlText(marker);
    } while (marker);

    return keys;
  }

  private url(tokens: AccountTokens, key = '', query?: URLSearchParams): URL {
    if (!tokens.azureAccountName || !tokens.azureContainer) {
      throw new ProviderError(this.id, 401, 'This Azure connection is incomplete');
    }

    const encoded = key
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');

    const url = new URL(
      `https://${tokens.azureAccountName}.blob.core.windows.net/${tokens.azureContainer}/${encoded}`,
    );

    if (query) url.search = query.toString();
    return url;
  }

  private async raw(
    tokens: AccountTokens,
    options: {
      method: 'GET' | 'HEAD' | 'PUT' | 'DELETE';
      key?: string;
      query?: URLSearchParams;
      headers?: Record<string, string>;
      body?: Uint8Array;
    },
  ): Promise<Response> {
    if (!tokens.azureAccountName || !tokens.azureAccountKey) {
      throw new ProviderError(this.id, 401, 'This Azure connection has no key');
    }

    const url = this.url(tokens, options.key ?? '', options.query);

    const headers: Record<string, string> = {
      ...options.headers,
      'x-ms-version': API_VERSION,
      'x-ms-date': new Date().toUTCString(),
    };

    // Put Blob needs the type declared; Put Block and Put Block List do not,
    // and setting it on those is rejected.
    if (options.method === 'PUT' && !options.query && !headers['x-ms-copy-source']) {
      headers['x-ms-blob-type'] = 'BlockBlob';
    }

    headers['authorization'] = signAzure({
      method: options.method,
      url: url.toString(),
      accountName: tokens.azureAccountName,
      accountKey: tokens.azureAccountKey,
      headers,
      ...(options.body ? { contentLength: options.body.byteLength } : {}),
    });

    return providerFetch(this.id, url.toString(), {
      method: options.method,
      headers,
      ...(options.body ? { body: options.body as unknown as BodyInit } : {}),
    });
  }

  private async request(
    tokens: AccountTokens,
    options: { method: 'GET' | 'HEAD' | 'PUT' | 'DELETE'; key?: string; query?: URLSearchParams },
  ): Promise<string> {
    const response = await this.raw(tokens, options);
    return response.text();
  }
}

// --- mapping ----------------------------------------------------------------

/** The blob-name prefix a virtual path corresponds to: "/a/b" becomes "a/b/". */
function prefixFor(path: string): string {
  const normalised = normalisePath(path);
  return normalised === '/' ? '' : `${normalised.slice(1)}/`;
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
    // A prefix has no timestamp; it is not stored anywhere.
    modifiedAt: new Date(0).toISOString(),
  };
}

export function azureToOrbitFile(entry: string): OrbitFile | null {
  const name = firstTag(entry, 'Name');
  if (!name) return null;

  const key = decodeXmlText(name);
  const properties = firstTag(entry, 'Properties') ?? entry;

  const size = Number(firstTag(properties, 'Content-Length') ?? '0');
  const modified = firstTag(properties, 'Last-Modified');
  const md5 = firstTag(properties, 'Content-MD5');
  const type = firstTag(properties, 'Content-Type');

  const file: OrbitFile = {
    remoteId: key,
    name: key.slice(key.lastIndexOf('/') + 1),
    virtualPath: `/${key}`,
    mimeType: (type && decodeXmlText(type)) || mimeForName(key),
    sizeBytes: Number.isFinite(size) ? size : 0,
    isFolder: false,
    starred: false,
    modifiedAt: modified ? new Date(decodeXmlText(modified)).toISOString() : new Date(0).toISOString(),
  };

  // Azure reports MD5 base64-encoded; hex is what everything else here uses,
  // and a checksum in two encodings compares equal to nothing.
  if (md5) {
    const hex = Buffer.from(decodeXmlText(md5), 'base64').toString('hex');
    if (hex.length === 32) file.checksum = hex;
  }

  return file;
}
