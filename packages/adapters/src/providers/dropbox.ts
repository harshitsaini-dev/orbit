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
  WorkspaceView,
} from '@orbit/shared-types';
import {
  BaseAdapter,
  joinPath,
  normalisePath,
  ProviderError,
  type AdapterCapabilities,
} from '../base.js';
import { providerFetch, providerJson } from '../http.js';

/**
 * Dropbox.
 *
 * Unusual in one way that shapes everything here: it is addressed by path, not
 * by id, and its paths are the same virtual paths Orbit already uses. So there
 * is no resolution step at all — no walking the tree to turn "/Photos/2026"
 * into an id, which is a request per segment on Drive.
 *
 * The other quirk is that almost every call is a POST with a JSON body, even
 * the ones that only read, and that downloads take their arguments in a header
 * rather than the body. Both are Dropbox's design, not a workaround.
 */

const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';

/** Dropbox recommends 8MB-150MB per chunk; the small end suits a free tier. */
const CHUNK_SIZE = 8 * 1024 * 1024;

interface DropboxEntry {
  '.tag': 'file' | 'folder' | 'deleted';
  id?: string;
  name: string;
  path_display?: string;
  path_lower?: string;
  size?: number;
  server_modified?: string;
  content_hash?: string;
}

interface ListResult {
  entries?: DropboxEntry[];
  cursor?: string;
  has_more?: boolean;
  matches?: Array<{ metadata?: { metadata?: DropboxEntry } }>;
}

export class DropboxAdapter extends BaseAdapter {
  readonly id: ProviderId = 'dropbox';
  readonly authType: AuthType = 'oauth';
  readonly displayName = 'Dropbox';
  readonly capabilities: AdapterCapabilities = {
    // Dropbox has starred files in its own UI but exposes no API for them.
    star: false,
    sharedWithMe: true,
    delta: true,
    resumableUpload: true,
    rangeRequests: true,
    nativeFolders: true,
    thumbnails: true,
    search: true,
    // Dropbox indexes contents for paid plans only, and there is no way to ask
    // which from the API - so this claims only what always works.
    fullTextSearch: false,
    recentView: false,
    flatEnumeration: true,
    reportsQuota: true,
  };

  // --- connection ---------------------------------------------------------

  override async connect(input: ConnectInput): Promise<AccountTokens> {
    if (input.kind !== 'oauth') throw new ProviderError(this.id, 400, 'Dropbox connects by OAuth');

    const body = new URLSearchParams({
      code: input.code,
      grant_type: 'authorization_code',
      redirect_uri: input.redirectUri,
      client_id: requireEnv('DROPBOX_CLIENT_ID'),
      client_secret: requireEnv('DROPBOX_CLIENT_SECRET'),
    });
    if (input.codeVerifier) body.set('code_verifier', input.codeVerifier);

    return this.exchange(body);
  }

  override async refreshToken(tokens: AccountTokens): Promise<AccountTokens> {
    if (!tokens.refreshToken) {
      throw new ProviderError(this.id, 400, 'No refresh token for this connection');
    }

    const refreshed = await this.exchange(
      new URLSearchParams({
        refresh_token: tokens.refreshToken,
        grant_type: 'refresh_token',
        client_id: requireEnv('DROPBOX_CLIENT_ID'),
        client_secret: requireEnv('DROPBOX_CLIENT_SECRET'),
      }),
    );

    // A refresh never returns a new refresh token here, so the old one carries.
    return { ...refreshed, refreshToken: refreshed.refreshToken ?? tokens.refreshToken };
  }

  private async exchange(body: URLSearchParams): Promise<AccountTokens> {
    const response = await providerJson<{
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    }>(this.id, TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    return {
      accessToken: response.access_token,
      ...(response.refresh_token ? { refreshToken: response.refresh_token } : {}),
      // Dropbox tokens last four hours; without the field, assume the shortest
      // plausible life rather than treating the token as eternal.
      expiresAt: Date.now() + (response.expires_in ?? 14_400) * 1000,
    };
  }

  async getAccountIdentity(
    tokens: AccountTokens,
  ): Promise<{ email?: string; displayName?: string; photoUrl?: string }> {
    const account = await this.rpc<{
      email?: string;
      name?: { display_name?: string };
      profile_photo_url?: string;
    }>(tokens, '/users/get_current_account', null);

    return {
      ...(account.email ? { email: account.email } : {}),
      ...(account.name?.display_name ? { displayName: account.name.display_name } : {}),
      ...(account.profile_photo_url ? { photoUrl: account.profile_photo_url } : {}),
    };
  }

  // --- reading ------------------------------------------------------------

  override async listFolder(
    tokens: AccountTokens,
    path: string,
    pageToken?: string,
  ): Promise<OrbitFilePage> {
    const result = pageToken
      ? await this.rpc<ListResult>(tokens, '/files/list_folder/continue', { cursor: pageToken })
      : await this.rpc<ListResult>(tokens, '/files/list_folder', {
          // The root is addressed as the empty string, not as "/" - Dropbox
          // rejects the slash outright.
          path: dropboxPath(path),
          limit: 500,
        });

    return this.toPage(result);
  }

  override async listAllFiles(tokens: AccountTokens, pageToken?: string): Promise<OrbitFilePage> {
    const result = pageToken
      ? await this.rpc<ListResult>(tokens, '/files/list_folder/continue', { cursor: pageToken })
      : await this.rpc<ListResult>(tokens, '/files/list_folder', {
          path: '',
          recursive: true,
          limit: 1000,
        });

    const page = this.toPage(result);
    // Folders hold no bytes and would double-count against their contents.
    return { ...page, files: page.files.filter((file) => !file.isFolder) };
  }

  override async listView(
    tokens: AccountTokens,
    view: WorkspaceView,
    pageToken?: string,
  ): Promise<OrbitFilePage> {
    if (view !== 'shared') {
      throw new ProviderError(
        this.id,
        501,
        `Dropbox exposes no API for ${view === 'starred' ? 'starred files' : 'recent files'}`,
      );
    }

    const result = pageToken
      ? await this.rpc<ListResult>(tokens, '/sharing/list_received_files/continue', {
          cursor: pageToken,
        })
      : await this.rpc<ListResult>(tokens, '/sharing/list_received_files', { limit: 100 });

    return this.toPage(result);
  }

  override async search(
    tokens: AccountTokens,
    query: SearchQuery,
    pageToken?: string,
  ): Promise<OrbitFilePage> {
    const result = pageToken
      ? await this.rpc<ListResult>(tokens, '/files/search/continue_v2', { cursor: pageToken })
      : await this.rpc<ListResult>(tokens, '/files/search_v2', {
          query: query.text ?? '',
          options: {
            path: query.underPath ? dropboxPath(query.underPath) : '',
            max_results: 100,
            // Names only: content search is a paid-plan feature and asking for
            // it on a free account fails the whole request.
            filename_only: true,
          },
        });

    // The search endpoint wraps each hit twice, unlike every other listing.
    const entries = (result.matches ?? [])
      .map((match) => match.metadata?.metadata)
      .filter((entry): entry is DropboxEntry => Boolean(entry));

    const files = entries
      .filter((entry) => entry['.tag'] !== 'deleted')
      .map((entry) => dropboxToOrbitFile(entry))
      .filter((file) => {
        if (query.minSizeBytes !== undefined && file.sizeBytes < query.minSizeBytes) return false;
        if (query.maxSizeBytes !== undefined && file.sizeBytes > query.maxSizeBytes) return false;
        if (query.modifiedAfter && file.modifiedAt < query.modifiedAfter) return false;
        if (query.starredOnly) return false;
        return true;
      });

    return {
      files,
      ...(result.has_more && result.cursor ? { nextPageToken: result.cursor } : {}),
    };
  }

  override async getFileMeta(tokens: AccountTokens, remoteId: string): Promise<OrbitFile> {
    const entry = await this.rpc<DropboxEntry>(tokens, '/files/get_metadata', { path: remoteId });
    return dropboxToOrbitFile(entry);
  }

  override async getFileStream(
    tokens: AccountTokens,
    remoteId: string,
    range?: ByteRange,
  ): Promise<FileStreamResult> {
    const headers: Record<string, string> = {
      ...this.auth(tokens),
      // Arguments travel in a header for content endpoints, because the body is
      // reserved for the file itself.
      'dropbox-api-arg': JSON.stringify({ path: remoteId }),
    };
    if (range) headers['range'] = `bytes=${range.start}-${range.end ?? ''}`;

    const response = await providerFetch(this.id, `${CONTENT}/files/download`, {
      method: 'POST',
      headers,
    });

    if (!response.body) throw new ProviderError(this.id, 502, 'Dropbox returned no body');

    const contentRange = response.headers.get('content-range');
    const contentLength = response.headers.get('content-length');

    return {
      stream: response.body,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      ...(contentLength ? { contentLength: Number(contentLength) } : {}),
      ...(contentRange ? { contentRange } : {}),
    };
  }

  override async getThumbnail(
    tokens: AccountTokens,
    remoteId: string,
    size = 256,
  ): Promise<FileStreamResult | null> {
    // Fixed sizes only; asking for one Dropbox does not offer fails outright.
    const name = size <= 64 ? 'w64h64' : size <= 128 ? 'w128h128' : size <= 480 ? 'w480h320' : 'w640h480';

    try {
      const response = await providerFetch(this.id, `${CONTENT}/files/get_thumbnail_v2`, {
        method: 'POST',
        headers: {
          ...this.auth(tokens),
          'dropbox-api-arg': JSON.stringify({
            resource: { '.tag': 'path', path: remoteId },
            size: { '.tag': name },
            format: { '.tag': 'jpeg' },
          }),
        },
      });

      if (!response.body) return null;
      return { stream: response.body, contentType: 'image/jpeg' };
    } catch (err) {
      // Most file types have no thumbnail, which is normal rather than a fault.
      if (err instanceof ProviderError && (err.status === 409 || err.status === 404)) return null;
      throw err;
    }
  }

  // --- writing ------------------------------------------------------------

  override async createFolder(tokens: AccountTokens, path: string, name: string): Promise<OrbitFile> {
    const target = joinPath(normalisePath(path), name);

    const created = await this.rpc<{ metadata?: DropboxEntry }>(tokens, '/files/create_folder_v2', {
      path: dropboxPath(target),
      autorename: true,
    });

    return created.metadata
      ? dropboxToOrbitFile(created.metadata)
      : {
          remoteId: target,
          name,
          virtualPath: target,
          mimeType: 'application/vnd.orbit.folder',
          sizeBytes: 0,
          isFolder: true,
          starred: false,
          modifiedAt: new Date().toISOString(),
        };
  }

  /**
   * A rename is a move, because the path is the identity: changing the last
   * segment is the only difference between the two operations.
   */
  override async rename(tokens: AccountTokens, remoteId: string, newName: string): Promise<void> {
    const parent = remoteId.slice(0, remoteId.lastIndexOf('/'));

    await this.rpc(tokens, '/files/move_v2', {
      from_path: remoteId,
      to_path: `${parent}/${newName}`,
      autorename: false,
    });
  }

  override async remove(tokens: AccountTokens, remoteIds: string[]): Promise<BulkResult> {
    const result: BulkResult = { succeeded: [], failed: [] };

    for (const remoteId of remoteIds) {
      try {
        // Dropbox keeps deleted files for 30 days, so this is recoverable in
        // the same way Drive's trash is.
        await this.rpc(tokens, '/files/delete_v2', { path: remoteId });
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
    const target = joinPath(normalisePath(path), meta.name);

    const session = await providerJson<{ session_id: string }>(
      this.id,
      `${CONTENT}/files/upload_session/start`,
      {
        method: 'POST',
        headers: {
          ...this.auth(tokens),
          'content-type': 'application/octet-stream',
          'dropbox-api-arg': JSON.stringify({ close: false }),
        },
        body: new Uint8Array() as unknown as BodyInit,
      },
    );

    return {
      provider: this.id,
      remoteSessionId: session.session_id,
      chunkSize: CHUNK_SIZE,
      state: {
        sessionId: session.session_id,
        offset: 0,
        totalBytes: meta.sizeBytes,
        virtualPath: target,
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
      sessionId: string;
      offset: number;
      totalBytes: number;
      virtualPath: string;
      tokens: AccountTokens;
    };

    const cursor = { session_id: state.sessionId, offset: state.offset };
    const isFinal = state.offset + chunk.byteLength >= state.totalBytes;

    if (!isFinal) {
      await providerFetch(this.id, `${CONTENT}/files/upload_session/append_v2`, {
        method: 'POST',
        headers: {
          ...this.auth(state.tokens),
          'content-type': 'application/octet-stream',
          'dropbox-api-arg': JSON.stringify({ cursor, close: false }),
        },
        body: chunk as unknown as BodyInit,
      });

      state.offset += chunk.byteLength;
      onProgress(state.offset);
      return { done: false };
    }

    const entry = await providerJson<DropboxEntry>(this.id, `${CONTENT}/files/upload_session/finish`, {
      method: 'POST',
      headers: {
        ...this.auth(state.tokens),
        'content-type': 'application/octet-stream',
        'dropbox-api-arg': JSON.stringify({
          cursor,
          commit: { path: dropboxPath(state.virtualPath), mode: 'add', autorename: true },
        }),
      },
      body: chunk as unknown as BodyInit,
    });

    state.offset += chunk.byteLength;
    onProgress(state.offset);

    return { done: true, file: dropboxToOrbitFile(entry) };
  }

  // --- account ------------------------------------------------------------

  override async getQuota(tokens: AccountTokens): Promise<Quota> {
    const usage = await this.rpc<{
      used?: number;
      allocation?: { allocated?: number; individual?: { allocated?: number } };
    }>(tokens, '/users/get_space_usage', null);

    return {
      usedBytes: usage.used ?? 0,
      // A team member's allowance is nested one level deeper than an
      // individual's, and only one of the two is ever present.
      totalBytes: usage.allocation?.allocated ?? usage.allocation?.individual?.allocated ?? 0,
    };
  }

  override async listChangesSince(
    tokens: AccountTokens,
    cursor: string | null,
  ): Promise<DeltaResult> {
    const result = cursor
      ? await this.rpc<ListResult>(tokens, '/files/list_folder/continue', { cursor })
      : await this.rpc<ListResult>(tokens, '/files/list_folder', {
          path: '',
          recursive: true,
          limit: 1000,
        });

    const changed: OrbitFile[] = [];
    const deletedRemoteIds: string[] = [];

    for (const entry of result.entries ?? []) {
      // A deleted entry carries only its path, which is the identity here, so
      // that is enough to remove it from the mirror.
      if (entry['.tag'] === 'deleted') deletedRemoteIds.push(entry.path_display ?? entry.name);
      else changed.push(dropboxToOrbitFile(entry));
    }

    return {
      changed,
      deletedRemoteIds,
      cursor: result.cursor ?? null,
      hasMore: Boolean(result.has_more),
    };
  }

  // --- plumbing -----------------------------------------------------------

  private auth(tokens: AccountTokens): Record<string, string> {
    if (!tokens.accessToken) throw new ProviderError(this.id, 401, 'No access token');
    return { authorization: `Bearer ${tokens.accessToken}` };
  }

  /**
   * Every metadata call is a POST with a JSON body, reads included.
   *
   * The endpoints that take no arguments want a literal `null` body rather than
   * an empty object or no body at all, which is why the argument is nullable
   * rather than optional.
   */
  private async rpc<T>(
    tokens: AccountTokens,
    endpoint: string,
    body: unknown,
  ): Promise<T> {
    return providerJson<T>(this.id, `${API}${endpoint}`, {
      method: 'POST',
      headers: { ...this.auth(tokens), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private toPage(result: ListResult): OrbitFilePage {
    const files = (result.entries ?? [])
      .filter((entry) => entry['.tag'] !== 'deleted')
      .map((entry) => dropboxToOrbitFile(entry));

    return {
      files,
      ...(result.has_more && result.cursor ? { nextPageToken: result.cursor } : {}),
    };
  }
}

// --- mapping --------------------------------------------------------------

/**
 * Dropbox's spelling of a path.
 *
 * The root is the empty string; "/" is rejected. Everything else is the same
 * virtual path Orbit uses, which is why this adapter never has to resolve a
 * path into an id.
 */
export function dropboxPath(path: string): string {
  const normalised = normalisePath(path);
  return normalised === '/' ? '' : normalised;
}

export function dropboxToOrbitFile(entry: DropboxEntry): OrbitFile {
  const isFolder = entry['.tag'] === 'folder';
  const path = entry.path_display ?? entry.path_lower ?? `/${entry.name}`;

  const file: OrbitFile = {
    // The path, not the id: it is what every Dropbox endpoint takes, and an id
    // would mean a lookup before each call.
    remoteId: path,
    name: entry.name,
    virtualPath: normalisePath(path),
    mimeType: isFolder ? 'application/vnd.orbit.folder' : guessMime(entry.name),
    sizeBytes: entry.size ?? 0,
    isFolder,
    starred: false,
    modifiedAt: entry.server_modified ?? new Date(0).toISOString(),
  };

  // Dropbox's content hash is its own construction - a hash of block hashes -
  // so it is comparable only with another Dropbox file, never with an MD5.
  if (entry.content_hash) file.checksum = entry.content_hash;

  return file;
}

function guessMime(name: string): string {
  const category = categorise(undefined, name);
  if (category === 'image') return 'image/*';
  if (category === 'video') return 'video/*';
  if (category === 'audio') return 'audio/*';
  return 'application/octet-stream';
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
