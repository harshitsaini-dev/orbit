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
import { BaseAdapter, joinPath, normalisePath, ProviderError, type AdapterCapabilities } from '../base.js';
import { providerFetch, providerJson } from '../http.js';

/**
 * Bunny Edge Storage.
 *
 * The simplest provider here by some distance: a flat REST API keyed on a
 * single storage-zone password, with paths that map straight onto Orbit's. No
 * OAuth, no signing, no tokens to refresh.
 *
 * What it does not have shapes the capabilities more than what it does. There
 * is no search, no delta feed, no starring, no trash - a delete is a delete -
 * and no multipart upload, so a file goes up in one PUT or not at all. Bunny
 * also reports no quota: a storage zone is billed by what is in it rather than
 * capped, so there is no allowance to be a fraction of.
 */

/** The main region. Others are prefixed, e.g. `ny.storage.bunnycdn.com`. */
const DEFAULT_HOST = 'storage.bunnycdn.com';

interface BunnyEntry {
  ObjectName: string;
  Path: string;
  Length: number;
  IsDirectory: boolean;
  LastChanged?: string;
  ContentType?: string;
  Checksum?: string;
}

export class BunnyAdapter extends BaseAdapter {
  readonly id: ProviderId = 'bunny';
  readonly authType: AuthType = 'access_key';
  readonly displayName = 'Bunny Storage';
  readonly capabilities: AdapterCapabilities = {
    star: false,
    sharedWithMe: false,
    delta: false,
    resumableUpload: false,
    rangeRequests: true,
    nativeFolders: true,
    /** A move would be a download and a re-upload, which is not a move. */
    relocate: false,
    thumbnails: false,
    search: false,
    fullTextSearch: false,
    recentView: false,
    /**
     * False: reaching every file means walking the tree a request per folder.
     * `listAllFiles` does exactly that, bounded, because the alternative is the
     * storage breakdown and the duplicate finder having nothing to read.
     */
    flatEnumeration: false,
    /** A zone is billed by what is in it; there is no allowance. */
    reportsQuota: false,
  };

  override async connect(input: ConnectInput): Promise<AccountTokens> {
    if (input.kind !== 'credentials') {
      throw new ProviderError(this.id, 400, 'Bunny Storage connects with a zone password');
    }

    const { bunnyStorageZone, bunnyAccessKey, bunnyRegionHost } = input.values;
    if (!bunnyStorageZone || !bunnyAccessKey) {
      throw new ProviderError(this.id, 400, 'A storage zone and its password are both required');
    }

    const tokens: AccountTokens = {
      bunnyStorageZone,
      bunnyAccessKey,
      bunnyRegionHost: bunnyRegionHost?.trim() || DEFAULT_HOST,
    };

    // Proved before it is stored: a wrong password saved silently becomes a
    // connection that fails later for no visible reason.
    await this.list(tokens, '/');
    return tokens;
  }

  override async refreshToken(tokens: AccountTokens): Promise<AccountTokens> {
    // A zone password does not expire, so there is nothing to renew.
    return tokens;
  }

  override async getQuota(): Promise<Quota> {
    // Bunny reports none, and inventing one would be worse than saying so.
    return { usedBytes: 0, totalBytes: 0 };
  }

  override async listFolder(tokens: AccountTokens, path: string): Promise<OrbitFilePage> {
    const parent = normalisePath(path);
    const entries = await this.list(tokens, parent);

    return { files: entries.map((entry) => bunnyToOrbitFile(entry, parent)) };
  }

  /**
   * Every file in the zone, by walking it.
   *
   * Bunny has no flat listing, so this is a request per folder - which is why
   * `flatEnumeration` is false and why it is bounded. It exists because the
   * storage breakdown and the duplicate finder read this feed, and a provider
   * that simply refuses is a provider those features silently skip.
   */
  override async listAllFiles(tokens: AccountTokens): Promise<OrbitFilePage> {
    const files: OrbitFile[] = [];
    const queue = ['/'];
    let visited = 0;

    while (queue.length > 0 && visited < MAX_FOLDERS) {
      const folder = queue.shift()!;
      visited += 1;

      for (const entry of await this.list(tokens, folder)) {
        const file = bunnyToOrbitFile(entry, folder);
        if (file.isFolder) queue.push(file.virtualPath);
        else files.push(file);
      }
    }

    return { files };
  }

  override async getFileMeta(tokens: AccountTokens, remoteId: string): Promise<OrbitFile> {
    const parent = parentOf(remoteId);
    const name = remoteId.slice(parent === '/' ? 1 : parent.length + 1);

    const match = (await this.list(tokens, parent)).find((entry) => entry.ObjectName === name);
    if (!match) throw new ProviderError(this.id, 404, `No file at ${remoteId}`);

    return bunnyToOrbitFile(match, parent);
  }

  override async getFileStream(
    tokens: AccountTokens,
    remoteId: string,
    range?: ByteRange,
  ): Promise<FileStreamResult> {
    const headers: Record<string, string> = { ...this.auth(tokens) };
    if (range) headers['range'] = `bytes=${range.start}-${range.end ?? ''}`;

    const response = await providerFetch(this.id, this.url(tokens, remoteId), { headers });
    if (!response.body) throw new ProviderError(this.id, 502, 'No body in the response');

    const length = response.headers.get('content-length');

    return {
      stream: response.body,
      contentType: response.headers.get('content-type') ?? mimeForName(remoteId),
      ...(length ? { contentLength: Number(length) } : {}),
    };
  }

  override async getThumbnail(): Promise<FileStreamResult | null> {
    // Bunny makes none. Orbit renders its own for images, which is why this
    // says no rather than pretending.
    return null;
  }

  override async createFolder(
    tokens: AccountTokens,
    path: string,
    name: string,
  ): Promise<OrbitFile> {
    /*
     * Bunny has no "create folder" call: a folder exists because something is
     * in it. An empty marker object gives Orbit something to list, which is the
     * same trick the object stores need.
     */
    const target = joinPath(normalisePath(path), name);

    await providerFetch(this.id, `${this.url(tokens, target)}/.orbit-folder`, {
      method: 'PUT',
      headers: { ...this.auth(tokens), 'content-type': 'application/octet-stream' },
      body: new Uint8Array(0),
    });

    return {
      remoteId: target,
      name,
      virtualPath: target,
      mimeType: 'application/x-directory',
      sizeBytes: 0,
      isFolder: true,
      starred: false,
      modifiedAt: new Date().toISOString(),
    };
  }

  override async rename(
    tokens: AccountTokens,
    remoteId: string,
    newName: string,
  ): Promise<void> {
    /*
     * There is no rename, and no server-side copy either.
     *
     * Renaming would mean pulling the file through Orbit and putting it back
     * under another name - which is a download and an upload wearing a
     * rename's clothes, and would silently cost somebody a gigabyte of transfer
     * for what looks like a text edit. Refused rather than done quietly.
     */
    void newName;
    void remoteId;
    throw new ProviderError(
      this.id,
      501,
      'Bunny Storage cannot rename a file without copying it. Download and re-upload it instead.',
    );
  }

  override async remove(tokens: AccountTokens, remoteIds: string[]): Promise<BulkResult> {
    const result: BulkResult = { succeeded: [], failed: [] };

    for (const remoteId of remoteIds) {
      try {
        // A trailing slash is how Bunny is told to remove a folder and
        // everything under it rather than an object of that name.
        const isFolder = remoteId.endsWith('/');
        await providerFetch(this.id, `${this.url(tokens, remoteId)}${isFolder ? '/' : ''}`, {
          method: 'DELETE',
          headers: this.auth(tokens),
        });
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
    throw new ProviderError(this.id, 501, 'Bunny Storage has no concept of starring');
  }

  override async initUpload(
    tokens: AccountTokens,
    path: string,
    meta: UploadMeta,
  ): Promise<UploadSession> {
    /*
     * One PUT, whole file. Bunny has no multipart upload, so `resumableUpload`
     * is false and the session exists only to carry the destination - there is
     * nothing to resume into.
     */
    const remoteId = joinPath(normalisePath(path), meta.name);

    return {
      provider: this.id,
      // No provider-side handle exists, because there is no session to hold
      // one: the path is the whole of what has to be remembered.
      remoteSessionId: remoteId,
      uploadUrl: this.url(tokens, remoteId),
      // One chunk, the whole file. Anything smaller would be a second PUT
      // overwriting the first.
      chunkSize: Math.max(meta.sizeBytes, 1),
      state: { remoteId, tokens },
    };
  }

  override async uploadChunk(
    session: UploadSession,
    chunk: Uint8Array,
    onProgress: (uploadedBytes: number) => void,
  ): Promise<{ done: boolean; file?: OrbitFile }> {
    const state = session.state as { remoteId: string; tokens: AccountTokens };

    await providerFetch(this.id, session.uploadUrl!, {
      method: 'PUT',
      headers: {
        ...this.auth(state.tokens),
        'content-type': 'application/octet-stream',
      },
      body: chunk as unknown as BodyInit,
    });

    onProgress(chunk.byteLength);

    const { remoteId } = state;
    const name = remoteId.slice(remoteId.lastIndexOf('/') + 1);

    return {
      done: true,
      file: {
        remoteId,
        name,
        virtualPath: remoteId,
        mimeType: mimeForName(name),
        sizeBytes: chunk.byteLength,
        isFolder: false,
        starred: false,
        modifiedAt: new Date().toISOString(),
      },
    };
  }

  // --- plumbing -------------------------------------------------------------

  private auth(tokens: AccountTokens): Record<string, string> {
    if (!tokens.bunnyAccessKey) {
      throw new ProviderError(this.id, 401, 'This Bunny connection has no key');
    }
    return { AccessKey: tokens.bunnyAccessKey, accept: 'application/json' };
  }

  /** `https://<region>/<zone>/<path>`, each segment encoded. */
  private url(tokens: AccountTokens, path: string): string {
    const host = tokens.bunnyRegionHost || DEFAULT_HOST;
    const encoded = normalisePath(path)
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join('/');

    return `https://${host}/${tokens.bunnyStorageZone}/${encoded}`;
  }

  private async list(tokens: AccountTokens, path: string): Promise<BunnyEntry[]> {
    // The trailing slash is what makes Bunny list rather than fetch - but the
    // zone root already ends in one, and doubling it asks for a folder whose
    // name is empty.
    const base = this.url(tokens, path);
    const url = base.endsWith('/') ? base : `${base}/`;

    const entries = await providerJson<BunnyEntry[]>(this.id, url, {
      headers: this.auth(tokens),
    });

    // The marker that only exists so an empty folder has something in it is
    // Orbit's own, and has no business being listed back to anybody.
    return (entries ?? []).filter((entry) => entry.ObjectName !== '.orbit-folder');
  }
}

/** A request per folder, so a pathological tree cannot walk for ever. */
const MAX_FOLDERS = 500;

function parentOf(remoteId: string): string {
  const trimmed = remoteId.endsWith('/') ? remoteId.slice(0, -1) : remoteId;
  const cut = trimmed.lastIndexOf('/');
  return cut <= 0 ? '/' : trimmed.slice(0, cut);
}

export function bunnyToOrbitFile(entry: BunnyEntry, parent: string): OrbitFile {
  const virtualPath = joinPath(parent, entry.ObjectName);

  const file: OrbitFile = {
    // The path is the id: Bunny addresses everything by path and hands out no
    // stable identifier of its own.
    remoteId: virtualPath,
    name: entry.ObjectName,
    virtualPath,
    mimeType: entry.IsDirectory
      ? 'application/x-directory'
      : entry.ContentType || mimeForName(entry.ObjectName),
    sizeBytes: entry.IsDirectory ? 0 : (entry.Length ?? 0),
    isFolder: entry.IsDirectory,
    starred: false,
    modifiedAt: entry.LastChanged ?? new Date(0).toISOString(),
  };

  if (entry.Checksum) file.checksum = entry.Checksum.toLowerCase();
  return file;
}
