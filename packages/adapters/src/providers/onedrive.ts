import { mimeForName } from '@orbit/shared-types';
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
 * OneDrive, through Microsoft Graph.
 *
 * Closer in shape to Drive than to an object store: real folders, a delta feed,
 * server-side search. The differences that matter are that Graph addresses
 * things by path as readily as by id — `/root:/Photos/2026:` is a folder — and
 * that it has no notion of starring, which the capabilities say so that the UI
 * hides the control rather than failing it.
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';
const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

/** Graph rejects a chunk that is not a multiple of 320 KiB, except the last. */
const CHUNK_SIZE = 320 * 1024 * 10;

const SELECT =
  'id,name,size,lastModifiedDateTime,file,folder,parentReference,webUrl,remoteItem';

interface GraphItem {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string; hashes?: { quickXorHash?: string; sha256Hash?: string } };
  folder?: { childCount?: number };
  parentReference?: { path?: string; driveId?: string };
  deleted?: { state?: string };
}

interface GraphPage {
  value?: GraphItem[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

export class OneDriveAdapter extends BaseAdapter {
  readonly id: ProviderId = 'onedrive';
  readonly authType: AuthType = 'oauth';
  readonly displayName = 'OneDrive';
  readonly capabilities: AdapterCapabilities = {
    // Graph has no "starred": the closest thing is a personal tag Orbit cannot
    // set, so the control is hidden rather than offered and then refused.
    star: false,
    sharedWithMe: true,
    delta: true,
    resumableUpload: true,
    rangeRequests: true,
    nativeFolders: true,
    relocate: true,
    thumbnails: true,
    search: true,
    fullTextSearch: true,
    recentView: true,
    // /drive/root/delta walks everything in one paginated pass.
    flatEnumeration: true,
    reportsQuota: true,
  };

  // --- connection ---------------------------------------------------------

  override async connect(input: ConnectInput): Promise<AccountTokens> {
    if (input.kind !== 'oauth') throw new ProviderError(this.id, 400, 'OneDrive connects by OAuth');

    const body = new URLSearchParams({
      client_id: requireEnv('ONEDRIVE_CLIENT_ID'),
      client_secret: requireEnv('ONEDRIVE_CLIENT_SECRET'),
      code: input.code,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
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
        client_id: requireEnv('ONEDRIVE_CLIENT_ID'),
        client_secret: requireEnv('ONEDRIVE_CLIENT_SECRET'),
        refresh_token: tokens.refreshToken,
        grant_type: 'refresh_token',
      }),
    );

    return {
      ...refreshed,
      // Microsoft rotates refresh tokens, but not on every exchange - keeping
      // the old one when none comes back is what stops a silent disconnection.
      refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
    };
  }

  private async exchange(body: URLSearchParams): Promise<AccountTokens> {
    const response = await providerJson<{
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    }>(this.id, TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    return {
      accessToken: response.access_token,
      ...(response.refresh_token ? { refreshToken: response.refresh_token } : {}),
      expiresAt: Date.now() + response.expires_in * 1000,
    };
  }

  async getAccountIdentity(
    tokens: AccountTokens,
  ): Promise<{ email?: string; displayName?: string }> {
    const me = await providerJson<{ mail?: string; userPrincipalName?: string; displayName?: string }>(
      this.id,
      `${GRAPH}/me`,
      { headers: this.auth(tokens) },
    );

    // A personal account often has no `mail`, only the principal name, which is
    // the address the person actually knows.
    return {
      ...(me.mail || me.userPrincipalName ? { email: me.mail ?? me.userPrincipalName } : {}),
      ...(me.displayName ? { displayName: me.displayName } : {}),
    };
  }

  // --- reading ------------------------------------------------------------

  override async listFolder(
    tokens: AccountTokens,
    path: string,
    pageToken?: string,
  ): Promise<OrbitFilePage> {
    const parent = normalisePath(path);

    const url = pageToken ?? `${GRAPH}/me/drive/${graphAddressOf(parent)}/children`;
    const page = await providerJson<GraphPage>(this.id, url, {
      headers: this.auth(tokens),
      ...(pageToken ? {} : { query: { $select: SELECT, $top: 200 } }),
    });

    return this.toPage(page, (item) => joinPath(parent, item.name));
  }

  override async listAllFiles(tokens: AccountTokens, pageToken?: string): Promise<OrbitFilePage> {
    // The delta feed without a token is a full enumeration, which is cheaper
    // than walking the tree folder by folder.
    const url = pageToken ?? `${GRAPH}/me/drive/root/delta`;
    const page = await providerJson<GraphPage>(this.id, url, { headers: this.auth(tokens) });

    return this.toPage(page, graphPathOf, (item) => !item.folder && !item.deleted);
  }

  override async listView(
    tokens: AccountTokens,
    view: WorkspaceView,
    pageToken?: string,
  ): Promise<OrbitFilePage> {
    if (view === 'starred') {
      throw new ProviderError(this.id, 501, 'OneDrive has no starred files');
    }

    const url =
      pageToken ??
      (view === 'recent' ? `${GRAPH}/me/drive/recent` : `${GRAPH}/me/drive/sharedWithMe`);

    const page = await providerJson<GraphPage>(this.id, url, { headers: this.auth(tokens) });
    return this.toPage(page, graphPathOf);
  }

  override async search(
    tokens: AccountTokens,
    query: SearchQuery,
    pageToken?: string,
  ): Promise<OrbitFilePage> {
    const text = query.text?.trim() ?? '';
    const scope = query.underPath ? graphAddressOf(normalisePath(query.underPath)) : 'root';

    // Graph's search covers names and, where it has indexed them, contents -
    // there is no way to ask for one and not the other.
    const url = pageToken ?? `${GRAPH}/me/drive/${scope}/search(q='${escapeGraphQuery(text)}')`;
    const page = await providerJson<GraphPage>(this.id, url, {
      headers: this.auth(tokens),
      ...(pageToken ? {} : { query: { $top: 200 } }),
    });

    const result = await this.toPage(page, graphPathOf);

    // Graph applies none of these, so they are applied here - the same query
    // has to mean the same thing on every provider.
    const files = result.files.filter((file) => {
      if (query.minSizeBytes !== undefined && file.sizeBytes < query.minSizeBytes) return false;
      if (query.maxSizeBytes !== undefined && file.sizeBytes > query.maxSizeBytes) return false;
      if (query.modifiedAfter && file.modifiedAt < query.modifiedAfter) return false;
      if (query.starredOnly) return false;
      return true;
    });

    return { files, ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}) };
  }

  override async getFileMeta(tokens: AccountTokens, remoteId: string): Promise<OrbitFile> {
    const item = await providerJson<GraphItem>(this.id, `${GRAPH}/me/drive/items/${remoteId}`, {
      headers: this.auth(tokens),
      query: { $select: SELECT },
    });

    return graphToOrbitFile(item, graphPathOf(item));
  }

  override async getFileStream(
    tokens: AccountTokens,
    remoteId: string,
    range?: ByteRange,
  ): Promise<FileStreamResult> {
    const headers: Record<string, string> = { ...this.auth(tokens) };
    if (range) headers['range'] = `bytes=${range.start}-${range.end ?? ''}`;

    const response = await providerFetch(this.id, `${GRAPH}/me/drive/items/${remoteId}/content`, {
      headers,
    });

    if (!response.body) throw new ProviderError(this.id, 502, 'OneDrive returned no body');

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
    // Graph offers fixed sizes rather than arbitrary ones; asking for a size it
    // does not have returns nothing at all.
    const name = size <= 48 ? 'small' : size <= 176 ? 'medium' : 'large';

    try {
      const response = await providerFetch(
        this.id,
        `${GRAPH}/me/drive/items/${remoteId}/thumbnails/0/${name}/content`,
        { headers: this.auth(tokens) },
      );

      if (!response.body) return null;
      return { stream: response.body, contentType: response.headers.get('content-type') ?? 'image/jpeg' };
    } catch (err) {
      // No thumbnail is the normal answer for most file types, not a failure.
      if (err instanceof ProviderError && err.status === 404) return null;
      throw err;
    }
  }

  // --- writing ------------------------------------------------------------

  override async createFolder(tokens: AccountTokens, path: string, name: string): Promise<OrbitFile> {
    const parent = normalisePath(path);

    const created = await providerJson<GraphItem>(
      this.id,
      `${GRAPH}/me/drive/${graphAddressOf(parent)}/children`,
      {
        method: 'POST',
        headers: { ...this.auth(tokens), 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          folder: {},
          // Without this Graph fails the whole request when the name is taken;
          // renaming is the behaviour every file manager has.
          '@microsoft.graph.conflictBehavior': 'rename',
        }),
      },
    );

    return graphToOrbitFile(created, joinPath(parent, created.name));
  }

  override async rename(tokens: AccountTokens, remoteId: string, newName: string): Promise<void> {
    await providerJson<GraphItem>(this.id, `${GRAPH}/me/drive/items/${remoteId}`, {
      method: 'PATCH',
      headers: { ...this.auth(tokens), 'content-type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    });
  }

  /**
   * A move is a change of parentReference. A copy is not: Graph makes copying
   * an asynchronous job, answering 202 with a URL to poll rather than the new
   * item - so the copy is started and the destination folder is described
   * instead of the file, which is the honest thing to return for work that has
   * not finished yet.
   */
  override async relocate(
    tokens: AccountTokens,
    remoteId: string,
    targetPath: string,
    options: { copy: boolean },
  ): Promise<OrbitFile> {
    // Addressed by path rather than looked up first: Graph accepts a path
    // address wherever it accepts an id, so this is one call instead of two.
    const parentReference = { path: `/drive/${graphAddressOf(targetPath)}`.replace(/:$/, '') };

    if (options.copy) {
      await providerFetch(this.id, `${GRAPH}/me/drive/items/${remoteId}/copy`, {
        method: 'POST',
        headers: { ...this.auth(tokens), 'content-type': 'application/json' },
        body: JSON.stringify({ parentReference }),
      });

      const source = await this.getFileMeta(tokens, remoteId);
      return { ...source, remoteId: '', virtualPath: joinPath(targetPath, source.name) };
    }

    const moved = await providerJson<GraphItem>(this.id, `${GRAPH}/me/drive/items/${remoteId}`, {
      method: 'PATCH',
      headers: { ...this.auth(tokens), 'content-type': 'application/json' },
      body: JSON.stringify({ parentReference }),
    });

    return graphToOrbitFile(moved, joinPath(targetPath, moved.name ?? ''));
  }

  override async remove(tokens: AccountTokens, remoteIds: string[]): Promise<BulkResult> {
    const result: BulkResult = { succeeded: [], failed: [] };

    for (const remoteId of remoteIds) {
      try {
        // Graph's DELETE moves the item to the recycle bin, so this is
        // recoverable in the same way Drive's trash is.
        await providerFetch(this.id, `${GRAPH}/me/drive/items/${remoteId}`, {
          method: 'DELETE',
          headers: this.auth(tokens),
        });
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
    const parent = normalisePath(path);
    const target = joinPath(parent, meta.name);

    const session = await providerJson<{ uploadUrl?: string }>(
      this.id,
      `${GRAPH}/me/drive/${graphAddressOf(target)}/createUploadSession`,
      {
        method: 'POST',
        headers: { ...this.auth(tokens), 'content-type': 'application/json' },
        body: JSON.stringify({
          item: { '@microsoft.graph.conflictBehavior': 'rename', name: meta.name },
        }),
      },
    );

    if (!session.uploadUrl) {
      throw new ProviderError(this.id, 502, 'OneDrive did not return an upload URL');
    }

    return {
      provider: this.id,
      remoteSessionId: session.uploadUrl,
      uploadUrl: session.uploadUrl,
      chunkSize: CHUNK_SIZE,
      state: { offset: 0, totalBytes: meta.sizeBytes, virtualPath: target },
    };
  }

  override async uploadChunk(
    session: UploadSession,
    chunk: Uint8Array,
    onProgress: (uploadedBytes: number) => void,
  ): Promise<{ done: boolean; file?: OrbitFile }> {
    const state = session.state as { offset: number; totalBytes: number; virtualPath: string };
    const start = state.offset;
    const end = start + chunk.byteLength - 1;

    // The upload URL is pre-authorised: sending the account's token to it as
    // well is both unnecessary and a way to leak one to a URL that does not
    // need it.
    const response = await fetch(session.uploadUrl!, {
      method: 'PUT',
      headers: {
        'content-length': String(chunk.byteLength),
        'content-range': `bytes ${start}-${end}/${state.totalBytes}`,
      },
      body: chunk as unknown as BodyInit,
    });

    state.offset = end + 1;
    onProgress(state.offset);

    // 202 means "chunk stored, keep going"; 200 or 201 come with the finished
    // item.
    if (response.status === 202) return { done: false };

    if (!response.ok) {
      throw new ProviderError(
        this.id,
        response.status,
        await response.text().catch(() => 'Upload failed'),
      );
    }

    const item = (await response.json()) as GraphItem;
    return { done: true, file: graphToOrbitFile(item, state.virtualPath) };
  }

  // --- account ------------------------------------------------------------

  override async getQuota(tokens: AccountTokens): Promise<Quota> {
    const drive = await providerJson<{ quota?: { used?: number; total?: number } }>(
      this.id,
      `${GRAPH}/me/drive`,
      { headers: this.auth(tokens) },
    );

    return {
      usedBytes: drive.quota?.used ?? 0,
      totalBytes: drive.quota?.total ?? 0,
    };
  }

  override async listChangesSince(
    tokens: AccountTokens,
    cursor: string | null,
  ): Promise<DeltaResult> {
    const url = cursor ?? `${GRAPH}/me/drive/root/delta`;
    const page = await providerJson<GraphPage>(this.id, url, { headers: this.auth(tokens) });

    const changed: OrbitFile[] = [];
    const deletedRemoteIds: string[] = [];

    for (const item of page.value ?? []) {
      // A deleted item still appears in the feed, marked - which is the only
      // way to learn something is gone.
      if (item.deleted) deletedRemoteIds.push(item.id);
      else changed.push(graphToOrbitFile(item, graphPathOf(item)));
    }

    const next = page['@odata.nextLink'] ?? page['@odata.deltaLink'] ?? null;

    return {
      changed,
      deletedRemoteIds,
      cursor: next,
      hasMore: Boolean(page['@odata.nextLink']),
    };
  }

  // --- plumbing -----------------------------------------------------------

  private auth(tokens: AccountTokens): Record<string, string> {
    if (!tokens.accessToken) throw new ProviderError(this.id, 401, 'No access token');
    return { authorization: `Bearer ${tokens.accessToken}` };
  }

  private async toPage(
    page: GraphPage,
    pathFor: (item: GraphItem) => string,
    keep: (item: GraphItem) => boolean = () => true,
  ): Promise<OrbitFilePage> {
    const files = (page.value ?? []).filter(keep).map((item) => graphToOrbitFile(item, pathFor(item)));
    const next = page['@odata.nextLink'];

    return { files, ...(next ? { nextPageToken: next } : {}) };
  }
}

// --- mapping --------------------------------------------------------------

/**
 * How Graph addresses a folder: by id for the root, by a quoted path otherwise.
 *
 * The trailing colon is not decoration - `/root:/Photos:` is a path address and
 * `/root/Photos` is not, and getting it wrong returns a 400 that says nothing
 * about which of the two was meant.
 */
export function graphAddressOf(path: string): string {
  const normalised = normalisePath(path);
  if (normalised === '/') return 'root';

  const encoded = normalised
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  return `root:/${encoded}:`;
}

/** Graph's own path, which arrives as "/drive/root:/Photos/2026". */
export function graphPathOf(item: GraphItem): string {
  const raw = item.parentReference?.path ?? '';
  const cut = raw.indexOf('root:');
  const parent = cut === -1 ? '' : decodeURIComponent(raw.slice(cut + 5));

  return normalisePath(`${parent}/${item.name}`);
}

/** Single quotes end the search term, and Graph escapes them by doubling. */
export function escapeGraphQuery(text: string): string {
  return text.replace(/'/g, "''");
}

export function graphToOrbitFile(item: GraphItem, virtualPath: string): OrbitFile {
  const isFolder = Boolean(item.folder);

  const file: OrbitFile = {
    remoteId: item.id,
    name: item.name,
    virtualPath,
    mimeType: isFolder
      ? 'application/vnd.orbit.folder'
      : (item.file?.mimeType ?? guessMime(item.name)),
    sizeBytes: item.size ?? 0,
    isFolder,
    // Graph has no starred; the field exists on every provider, so it is false
    // rather than absent.
    starred: false,
    modifiedAt: item.lastModifiedDateTime ?? new Date(0).toISOString(),
  };

  // quickXorHash is Microsoft's own algorithm and comparable only with itself,
  // so only the SHA-256 is worth presenting as a checksum.
  const sha = item.file?.hashes?.sha256Hash;
  if (sha) file.checksum = sha.toLowerCase();

  return file;
}

/**
 * This provider says only "image" or "video", so the extension has to supply
 * the actual type. It used to return `image/*`, which is a match pattern rather
 * than a media type - meaningless in a `<video>` source and false to anything
 * comparing against a specific type.
 */
function guessMime(name: string): string {
  return mimeForName(name);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
