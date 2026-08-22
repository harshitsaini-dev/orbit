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
 * pCloud.
 *
 * Two things shape this adapter more than anything else.
 *
 * The account lives in one of two regions and which one is not knowable until
 * sign-in: the token response names the host, and every later call has to go
 * there. Sending a US account's token to the EU host is an authentication
 * failure that looks like a bad password.
 *
 * And pCloud addresses things by numeric id as well as by path. Ids are used
 * here, because they survive a rename and because the trash only speaks ids -
 * a bin keyed on paths could not restore anything whose folder had since moved.
 */

/** The two regions pCloud runs. `locationid` in the token response picks one. */
const HOSTS: Record<string, string> = { '1': 'https://api.pcloud.com', '2': 'https://eapi.pcloud.com' };
const DEFAULT_HOST = HOSTS['1']!;

/** pCloud answers 200 with a `result` field rather than an HTTP status. */
interface PCloudResponse {
  result: number;
  error?: string;
}

interface PCloudMeta {
  name?: string;
  isfolder?: boolean;
  fileid?: number;
  folderid?: number;
  size?: number;
  contenttype?: string;
  modified?: string;
  hash?: number;
  path?: string;
  thumb?: boolean;
  contents?: PCloudMeta[];
}

export class PCloudAdapter extends BaseAdapter {
  readonly id: ProviderId = 'pcloud';
  readonly authType: AuthType = 'oauth';
  readonly displayName = 'pCloud';
  readonly capabilities: AdapterCapabilities = {
    star: false,
    sharedWithMe: false,
    /** pCloud has a diff feed, but Orbit does not use it yet. */
    delta: false,
    resumableUpload: true,
    rangeRequests: true,
    nativeFolders: true,
    /** A real bin, and one an ordinary account may empty. */
    trash: true,
    purgeTrash: true,
    /** renamefile/copyfile are server-side, so no bytes come through Orbit. */
    relocate: true,
    thumbnails: true,
    search: false,
    fullTextSearch: false,
    recentView: false,
    /** Reaching every file means walking the tree, as with Bunny. */
    flatEnumeration: false,
    reportsQuota: true,
  };

  override async connect(input: ConnectInput): Promise<AccountTokens> {
    if (input.kind !== 'oauth') {
      throw new ProviderError(this.id, 400, 'pCloud connects through OAuth');
    }

    const clientId = requireEnv('PCLOUD_CLIENT_ID');
    const clientSecret = requireEnv('PCLOUD_CLIENT_SECRET');

    const query = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: input.code,
    });

    /*
     * The exchange goes to the common host; everything after it goes to the one
     * named in the reply.
     *
     * `locationid` is how pCloud says which region the account is in. Getting
     * this wrong is an authentication failure on every later call, which reads
     * like a bad token rather than a wrong host.
     */
    const response = await providerJson<
      PCloudResponse & { access_token?: string; locationid?: number; hostname?: string }
    >(this.id, `${DEFAULT_HOST}/oauth2_token?${query.toString()}`, {});

    this.assertOk(response);
    if (!response.access_token) {
      throw new ProviderError(this.id, 502, 'pCloud returned no access token');
    }

    return {
      accessToken: response.access_token,
      endpoint: response.hostname
        ? `https://${response.hostname}`
        : (HOSTS[String(response.locationid ?? 1)] ?? DEFAULT_HOST),
    };
  }

  override async refreshToken(tokens: AccountTokens): Promise<AccountTokens> {
    // pCloud tokens do not expire unless revoked, so there is nothing to renew
    // - and inventing a refresh would mark a healthy connection dead.
    return tokens;
  }

  async getAccountIdentity(
    tokens: AccountTokens,
  ): Promise<{ email?: string; displayName?: string }> {
    const info = await this.call<PCloudResponse & { email?: string }>(tokens, 'userinfo');
    return info.email ? { email: info.email } : {};
  }

  override async getQuota(tokens: AccountTokens): Promise<Quota> {
    const info = await this.call<PCloudResponse & { quota?: number; usedquota?: number }>(
      tokens,
      'userinfo',
    );

    return { usedBytes: info.usedquota ?? 0, totalBytes: info.quota ?? 0 };
  }

  override async listFolder(tokens: AccountTokens, path: string): Promise<OrbitFilePage> {
    const parent = normalisePath(path);

    const result = await this.call<PCloudResponse & { metadata?: PCloudMeta }>(tokens, 'listfolder', {
      path: parent,
    });

    const contents = result.metadata?.contents ?? [];
    return { files: contents.map((entry) => pcloudToOrbitFile(entry, parent)) };
  }

  /**
   * Every file, by walking the tree.
   *
   * pCloud can return a whole subtree in one call with `recursive=1`, which is
   * why this is one request rather than one per folder - but it is still not a
   * flat enumeration in the sense the capability means, since the answer is a
   * nested structure that has to be flattened here.
   */
  override async listAllFiles(tokens: AccountTokens): Promise<OrbitFilePage> {
    const result = await this.call<PCloudResponse & { metadata?: PCloudMeta }>(tokens, 'listfolder', {
      path: '/',
      recursive: '1',
    });

    const files: OrbitFile[] = [];

    const walk = (entry: PCloudMeta, parent: string): void => {
      for (const child of entry.contents ?? []) {
        const mapped = pcloudToOrbitFile(child, parent);
        if (mapped.isFolder) walk(child, mapped.virtualPath);
        else files.push(mapped);
      }
    };

    if (result.metadata) walk(result.metadata, '/');
    return { files };
  }

  override async getFileMeta(tokens: AccountTokens, remoteId: string): Promise<OrbitFile> {
    const result = await this.call<PCloudResponse & { metadata?: PCloudMeta }>(
      tokens,
      'stat',
      idParams(remoteId),
    );

    if (!result.metadata) throw new ProviderError(this.id, 404, `No file for ${remoteId}`);

    const meta = result.metadata;
    const path = meta.path ?? `/${meta.name ?? ''}`;
    return pcloudToOrbitFile(meta, path.slice(0, path.lastIndexOf('/')) || '/');
  }

  override async getFileStream(
    tokens: AccountTokens,
    remoteId: string,
    range?: ByteRange,
  ): Promise<FileStreamResult> {
    // pCloud hands out a one-time link on a content host rather than serving
    // the bytes from the API host.
    const link = await this.call<PCloudResponse & { hosts?: string[]; path?: string }>(
      tokens,
      'getfilelink',
      idParams(remoteId),
    );

    const host = link.hosts?.[0];
    if (!host || !link.path) {
      throw new ProviderError(this.id, 502, 'pCloud returned no download link');
    }

    const headers: Record<string, string> = {};
    if (range) headers['range'] = `bytes=${range.start}-${range.end ?? ''}`;

    const response = await providerFetch(this.id, `https://${host}${link.path}`, { headers });
    if (!response.body) throw new ProviderError(this.id, 502, 'No body in the response');

    const length = response.headers.get('content-length');

    return {
      stream: response.body,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      ...(length ? { contentLength: Number(length) } : {}),
    };
  }

  override async getThumbnail(
    tokens: AccountTokens,
    remoteId: string,
    size = 256,
  ): Promise<FileStreamResult | null> {
    try {
      const link = await this.call<PCloudResponse & { hosts?: string[]; path?: string }>(
        tokens,
        'getthumblink',
        { ...idParams(remoteId), size: `${size}x${size}` },
      );

      const host = link.hosts?.[0];
      if (!host || !link.path) return null;

      const response = await providerFetch(this.id, `https://${host}${link.path}`, {});
      if (!response.body) return null;

      return {
        stream: response.body,
        contentType: response.headers.get('content-type') ?? 'image/jpeg',
      };
    } catch {
      // pCloud makes thumbnails for images and nothing else, and says so with
      // an error rather than an empty answer. An icon is the right outcome.
      return null;
    }
  }

  override async createFolder(
    tokens: AccountTokens,
    path: string,
    name: string,
  ): Promise<OrbitFile> {
    const target = joinPath(normalisePath(path), name);

    const result = await this.call<PCloudResponse & { metadata?: PCloudMeta }>(
      tokens,
      'createfolderifnotexists',
      { path: target },
    );

    if (!result.metadata) throw new ProviderError(this.id, 502, 'pCloud created no folder');
    return pcloudToOrbitFile(result.metadata, normalisePath(path));
  }

  override async rename(tokens: AccountTokens, remoteId: string, newName: string): Promise<void> {
    await this.call(tokens, remoteId.startsWith('d') ? 'renamefolder' : 'renamefile', {
      ...idParams(remoteId),
      toname: newName,
    });
  }

  override async relocate(
    tokens: AccountTokens,
    remoteId: string,
    targetPath: string,
    options: { copy: boolean },
  ): Promise<OrbitFile> {
    const isFolder = remoteId.startsWith('d');

    if (options.copy && isFolder) {
      // pCloud copies files server-side but not folders, and doing it by hand
      // would mean pulling every file through Orbit to put it back.
      throw new ProviderError(this.id, 501, 'pCloud cannot copy a folder server-side');
    }

    const method = options.copy ? 'copyfile' : isFolder ? 'renamefolder' : 'renamefile';

    const result = await this.call<PCloudResponse & { metadata?: PCloudMeta }>(tokens, method, {
      ...idParams(remoteId),
      topath: `${normalisePath(targetPath) === '/' ? '' : normalisePath(targetPath)}/`,
    });

    if (!result.metadata) throw new ProviderError(this.id, 502, 'pCloud moved nothing');
    return pcloudToOrbitFile(result.metadata, normalisePath(targetPath));
  }

  override async remove(tokens: AccountTokens, remoteIds: string[]): Promise<BulkResult> {
    const result: BulkResult = { succeeded: [], failed: [] };

    for (const remoteId of remoteIds) {
      try {
        // Recursive for a folder: deleting the folder alone leaves what was in
        // it unreachable rather than deleted.
        await this.call(
          tokens,
          remoteId.startsWith('d') ? 'deletefolderrecursive' : 'deletefile',
          idParams(remoteId),
        );
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
    throw new ProviderError(this.id, 501, 'pCloud has no concept of starring');
  }

  // --- the bin --------------------------------------------------------------

  async listTrash(tokens: AccountTokens): Promise<OrbitFilePage> {
    const result = await this.call<PCloudResponse & { metadata?: PCloudMeta }>(
      tokens,
      'trash_list',
      { folderid: '0', recursive: '1' },
    );

    const files: OrbitFile[] = [];

    const walk = (entry: PCloudMeta, parent: string): void => {
      for (const child of entry.contents ?? []) {
        const mapped = pcloudToOrbitFile(child, parent);
        if (mapped.isFolder) walk(child, mapped.virtualPath);
        else files.push(mapped);
      }
    };

    if (result.metadata) walk(result.metadata, '/');
    return { files };
  }

  async restoreFromTrash(tokens: AccountTokens, remoteId: string): Promise<void> {
    await this.call(tokens, 'trash_restore', idParams(remoteId));
  }

  async purgeFromTrash(tokens: AccountTokens, remoteId: string): Promise<void> {
    await this.call(tokens, 'trash_clear', idParams(remoteId));
  }

  // --- upload ---------------------------------------------------------------

  override async initUpload(
    tokens: AccountTokens,
    path: string,
    meta: UploadMeta,
  ): Promise<UploadSession> {
    // file_open with O_CREAT gives a handle that survives across writes, which
    // is what makes this resumable rather than one enormous request.
    const opened = await this.call<PCloudResponse & { fd?: number; fileid?: number }>(
      tokens,
      'file_open',
      {
        // 0x0040 is O_CREAT; combined with the path, pCloud makes the file.
        flags: String(0x0040),
        path: joinPath(normalisePath(path), meta.name),
      },
    );

    if (opened.fd === undefined) throw new ProviderError(this.id, 502, 'pCloud opened no file');

    return {
      provider: this.id,
      remoteSessionId: String(opened.fd),
      chunkSize: 8 * 1024 * 1024,
      state: {
        fd: opened.fd,
        tokens,
        virtualPath: joinPath(normalisePath(path), meta.name),
        uploaded: 0,
        totalBytes: meta.sizeBytes,
      },
    };
  }

  override async uploadChunk(
    session: UploadSession,
    chunk: Uint8Array,
    onProgress: (uploadedBytes: number) => void,
  ): Promise<{ done: boolean; file?: OrbitFile }> {
    const state = session.state as {
      fd: number;
      tokens: AccountTokens;
      virtualPath: string;
      uploaded: number;
      totalBytes: number;
    };

    await providerFetch(
      this.id,
      `${host(state.tokens)}/file_write?fd=${state.fd}&offset=${state.uploaded}`,
      {
        method: 'POST',
        headers: this.auth(state.tokens),
        body: chunk as unknown as BodyInit,
      },
    );

    state.uploaded += chunk.byteLength;
    onProgress(state.uploaded);

    if (state.uploaded < state.totalBytes) return { done: false };

    // Closed explicitly: a handle left open holds the file in a state where
    // its size is not yet what was written.
    await this.call(state.tokens, 'file_close', { fd: String(state.fd) });

    const result = await this.call<PCloudResponse & { metadata?: PCloudMeta }>(
      state.tokens,
      'stat',
      { path: state.virtualPath },
    );

    const parent = state.virtualPath.slice(0, state.virtualPath.lastIndexOf('/')) || '/';
    return {
      done: true,
      ...(result.metadata ? { file: pcloudToOrbitFile(result.metadata, parent) } : {}),
    };
  }

  // --- plumbing -------------------------------------------------------------

  private auth(tokens: AccountTokens): Record<string, string> {
    if (!tokens.accessToken) {
      throw new ProviderError(this.id, 401, 'This pCloud connection has no token');
    }
    return { authorization: `Bearer ${tokens.accessToken}` };
  }

  /**
   * pCloud answers 200 with a `result` code rather than an HTTP status, so a
   * failure looks like a success to anything that only checks the status.
   */
  private assertOk(response: PCloudResponse): void {
    if (response.result === 0) return;

    // 1000-1999 are authentication failures; the rest are ordinary errors.
    const status = response.result >= 1000 && response.result < 2000 ? 401 : 400;
    throw new ProviderError(this.id, status, response.error ?? `pCloud error ${response.result}`);
  }

  private async call<T extends PCloudResponse>(
    tokens: AccountTokens,
    method: string,
    params: Record<string, string> = {},
  ): Promise<T> {
    const query = new URLSearchParams(params);
    const response = await providerJson<T>(
      this.id,
      `${host(tokens)}/${method}?${query.toString()}`,
      { headers: this.auth(tokens) },
    );

    this.assertOk(response);
    return response;
  }
}

// --- mapping ----------------------------------------------------------------

function host(tokens: AccountTokens): string {
  return tokens.endpoint || DEFAULT_HOST;
}

/**
 * Orbit's remote id for a pCloud item: `f` or `d` and the number.
 *
 * Ids rather than paths, because they survive a rename and because the trash
 * only speaks ids - a bin keyed on paths could not restore anything whose
 * folder had since moved.
 */
function idParams(remoteId: string): Record<string, string> {
  const numeric = remoteId.slice(1);
  return remoteId.startsWith('d') ? { folderid: numeric } : { fileid: numeric };
}

export function pcloudToOrbitFile(entry: PCloudMeta, parent: string): OrbitFile {
  const isFolder = Boolean(entry.isfolder);
  const name = entry.name ?? '';

  const file: OrbitFile = {
    remoteId: isFolder ? `d${entry.folderid ?? 0}` : `f${entry.fileid ?? 0}`,
    name,
    virtualPath: entry.path ?? joinPath(parent, name),
    mimeType: isFolder ? 'application/x-directory' : entry.contenttype || mimeForName(name),
    sizeBytes: isFolder ? 0 : (entry.size ?? 0),
    isFolder,
    starred: false,
    modifiedAt: entry.modified ? new Date(entry.modified).toISOString() : new Date(0).toISOString(),
  };

  /*
   * pCloud's `hash` is its own 64-bit construction rather than an MD5, so it is
   * comparable with another pCloud file and nothing else. Recorded as such - the
   * duplicate finder already refuses to compare checksums across providers.
   */
  if (!isFolder && entry.hash !== undefined) file.checksum = `pcloud:${entry.hash}`;

  return file;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
