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
  UploadMeta,
  UploadSession,
} from '@orbit/shared-types';
import { BaseAdapter, ProviderError, joinPath, normalisePath, type AdapterCapabilities } from '../base.js';
import { providerFetch, providerJson } from '../http.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const GOOGLE_DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const GOOGLE_DRIVE_SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

/** Drive resumable uploads require a multiple of 256 KiB for every chunk but the last. */
const CHUNK_SIZE = 8 * 1024 * 1024;

const FILE_FIELDS =
  'id,name,mimeType,size,modifiedTime,starred,trashed,parents,md5Checksum,shortcutDetails';

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  starred?: boolean;
  trashed?: boolean;
  parents?: string[];
  md5Checksum?: string;
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
}

interface DriveList {
  files?: DriveFile[];
  nextPageToken?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

/**
 * Google Drive.
 *
 * Three things about Drive shape the code below. It is a graph rather than a
 * tree - a file can sit in several parents - so Orbit resolves its virtual
 * paths by walking from the root a segment at a time. Google's own document
 * formats are not stored as bytes at all; they report no size and cannot be
 * fetched with alt=media, so they are exported instead. And a shortcut is a
 * distinct kind of entry that must behave like whatever it points at, or a
 * shortcut to a folder appears as an unopenable zero-byte file.
 */
export class GoogleDriveAdapter extends BaseAdapter {
  readonly id: ProviderId = 'google_drive';
  readonly authType: AuthType = 'oauth';
  readonly displayName = 'Google Drive';
  readonly capabilities: AdapterCapabilities = {
    star: true,
    sharedWithMe: true,
    delta: true,
    resumableUpload: true,
    rangeRequests: true,
    nativeFolders: true,
    flatEnumeration: true,
    reportsQuota: true,
  };

  // --- auth ---------------------------------------------------------------

  override async connect(input: ConnectInput): Promise<AccountTokens> {
    if (input.kind !== 'oauth') {
      throw new ProviderError(this.id, 400, 'Google Drive connects by OAuth');
    }

    const clientId = requireEnv('GOOGLE_CLIENT_ID');
    const clientSecret = requireEnv('GOOGLE_CLIENT_SECRET');

    const body = new URLSearchParams({
      code: input.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
    });
    if (input.codeVerifier) body.set('code_verifier', input.codeVerifier);

    const token = await providerJson<TokenResponse>(this.id, TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!token.refresh_token) {
      // Without offline access the connection dies in an hour and cannot be
      // renewed, so fail now rather than halfway through the first sync.
      throw new ProviderError(
        this.id,
        400,
        'Google returned no refresh token. The authorise URL needs access_type=offline and prompt=consent.',
      );
    }

    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + token.expires_in * 1000,
    };
  }

  override async refreshToken(tokens: AccountTokens): Promise<AccountTokens> {
    if (!tokens.refreshToken) {
      throw new ProviderError(this.id, 401, 'No refresh token stored; the account must reconnect');
    }

    const refreshed = await providerJson<TokenResponse>(this.id, TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: tokens.refreshToken,
        client_id: requireEnv('GOOGLE_CLIENT_ID'),
        client_secret: requireEnv('GOOGLE_CLIENT_SECRET'),
        grant_type: 'refresh_token',
      }),
    });

    return {
      ...tokens,
      accessToken: refreshed.access_token,
      // Google only re-issues a refresh token when it rotates one.
      refreshToken: refreshed.refresh_token ?? tokens.refreshToken,
      expiresAt: Date.now() + refreshed.expires_in * 1000,
    };
  }

  /** Who the account belongs to. Labels the connection, and seeds an empty profile. */
  async getAccountIdentity(
    tokens: AccountTokens,
  ): Promise<{ email?: string; displayName?: string; photoUrl?: string }> {
    const about = await providerJson<{
      user?: { emailAddress?: string; displayName?: string; photoLink?: string };
    }>(this.id, `${API}/about`, {
      headers: this.auth(tokens),
      query: { fields: 'user(emailAddress,displayName,photoLink)' },
    });

    return {
      email: about.user?.emailAddress,
      displayName: about.user?.displayName,
      photoUrl: about.user?.photoLink,
    };
  }

  /** The address the account is labelled with in the UI. */
  async getAccountEmail(tokens: AccountTokens): Promise<string | undefined> {
    return (await this.getAccountIdentity(tokens)).email;
  }

  // --- reading ------------------------------------------------------------

  override async listFolder(
    tokens: AccountTokens,
    path: string,
    pageToken?: string,
  ): Promise<OrbitFilePage> {
    const parent = normalisePath(path);
    const folderId = await this.resolvePath(tokens, parent);

    const page = await providerJson<DriveList>(this.id, `${API}/files`, {
      headers: this.auth(tokens),
      query: {
        q: `'${folderId}' in parents and trashed = false`,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: 200,
        pageToken,
        // Without these, files in a Shared drive are simply missing from the listing.
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        orderBy: 'folder,name_natural',
      },
    });

    return {
      files: (page.files ?? []).map((file) => toOrbitFile(file, joinPath(parent, file.name))),
      nextPageToken: page.nextPageToken,
    };
  }

  /**
   * Every file in the account, flat. One query rather than one per folder,
   * which is the difference between a handful of requests and thousands on a
   * drive of any size. Folders are excluded: they hold no bytes and would
   * double-count against their contents.
   */
  override async listAllFiles(tokens: AccountTokens, pageToken?: string): Promise<OrbitFilePage> {
    const page = await providerJson<DriveList>(this.id, `${API}/files`, {
      headers: this.auth(tokens),
      query: {
        q: `trashed = false and mimeType != '${GOOGLE_DRIVE_FOLDER_MIME}'`,
        // Only what the breakdown actually needs; asking for less makes each
        // page markedly cheaper on an account with a hundred thousand files.
        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,shortcutDetails(targetMimeType))',
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      },
    });

    return {
      files: (page.files ?? []).map((file) => toOrbitFile(file, `/${file.name}`)),
      nextPageToken: page.nextPageToken,
    };
  }

  /** Files other people shared. A separate query, not a folder. */
  async listSharedWithMe(tokens: AccountTokens, pageToken?: string): Promise<OrbitFilePage> {
    const page = await providerJson<DriveList>(this.id, `${API}/files`, {
      headers: this.auth(tokens),
      query: {
        q: 'sharedWithMe = true and trashed = false',
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: 200,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      },
    });

    return {
      files: (page.files ?? []).map((file) => toOrbitFile(file, `/Shared with me/${file.name}`)),
      nextPageToken: page.nextPageToken,
    };
  }

  override async getFileMeta(tokens: AccountTokens, remoteId: string): Promise<OrbitFile> {
    const file = await this.fetchFile(tokens, remoteId, FILE_FIELDS);
    return toOrbitFile(file, `/${file.name}`);
  }

  override async getFileStream(
    tokens: AccountTokens,
    remoteId: string,
    range?: ByteRange,
  ): Promise<FileStreamResult> {
    const meta = await this.fetchFile(tokens, remoteId, 'mimeType,size,shortcutDetails');
    // Content lives on the target, never on the shortcut itself.
    const contentId = meta.shortcutDetails?.targetId ?? remoteId;

    const headers = this.auth(tokens);
    if (range) {
      headers.range = `bytes=${range.start}-${range.end ?? ''}`;
    }

    const exportMime = EXPORT_FORMATS[meta.mimeType];
    const response = exportMime
      ? // Google's own formats hold no bytes; they are converted on request.
        await providerFetch(this.id, `${API}/files/${encodeURIComponent(contentId)}/export`, {
          headers,
          query: { mimeType: exportMime },
        })
      : await providerFetch(this.id, `${API}/files/${encodeURIComponent(contentId)}`, {
          headers,
          query: { alt: 'media', supportsAllDrives: true },
        });

    if (!response.body) throw new ProviderError(this.id, 502, 'Drive returned an empty body');

    const length = response.headers.get('content-length');
    return {
      stream: response.body,
      contentType: response.headers.get('content-type') ?? exportMime ?? meta.mimeType,
      contentLength: length ? Number(length) : undefined,
      contentRange: response.headers.get('content-range') ?? undefined,
    };
  }

  override async getQuota(tokens: AccountTokens): Promise<Quota> {
    const about = await providerJson<{
      storageQuota?: { limit?: string; usage?: string };
    }>(this.id, `${API}/about`, {
      headers: this.auth(tokens),
      query: { fields: 'storageQuota' },
    });

    return {
      usedBytes: Number(about.storageQuota?.usage ?? 0),
      // A Workspace account with pooled storage reports no limit at all.
      totalBytes: Number(about.storageQuota?.limit ?? 0),
    };
  }

  // --- writing ------------------------------------------------------------

  override async createFolder(tokens: AccountTokens, path: string, name: string): Promise<OrbitFile> {
    const parentId = await this.resolvePath(tokens, path);

    const created = await providerJson<DriveFile>(this.id, `${API}/files`, {
      method: 'POST',
      headers: { ...this.auth(tokens), 'content-type': 'application/json' },
      query: { fields: FILE_FIELDS, supportsAllDrives: true },
      body: JSON.stringify({ name, mimeType: GOOGLE_DRIVE_FOLDER_MIME, parents: [parentId] }),
    });

    return toOrbitFile(created, joinPath(path, name));
  }

  override async rename(tokens: AccountTokens, remoteId: string, newName: string): Promise<void> {
    await providerFetch(this.id, `${API}/files/${encodeURIComponent(remoteId)}`, {
      method: 'PATCH',
      headers: { ...this.auth(tokens), 'content-type': 'application/json' },
      query: { supportsAllDrives: true },
      body: JSON.stringify({ name: newName }),
    });
  }

  override async star(tokens: AccountTokens, remoteId: string, starred: boolean): Promise<void> {
    await providerFetch(this.id, `${API}/files/${encodeURIComponent(remoteId)}`, {
      method: 'PATCH',
      headers: { ...this.auth(tokens), 'content-type': 'application/json' },
      query: { supportsAllDrives: true },
      body: JSON.stringify({ starred }),
    });
  }

  /**
   * Trashes rather than permanently deletes. A delete through an aggregator is
   * far too easy to trigger by accident, and Drive's own trash is a recovery
   * path the user already understands.
   */
  override async remove(tokens: AccountTokens, remoteIds: string[]): Promise<BulkResult> {
    const result: BulkResult = { succeeded: [], failed: [] };

    for (const remoteId of remoteIds) {
      try {
        await providerFetch(this.id, `${API}/files/${encodeURIComponent(remoteId)}`, {
          method: 'PATCH',
          headers: { ...this.auth(tokens), 'content-type': 'application/json' },
          query: { supportsAllDrives: true },
          body: JSON.stringify({ trashed: true }),
        });
        result.succeeded.push(remoteId);
      } catch (err) {
        // One failure must not abandon the rest of a bulk selection.
        result.failed.push({
          remoteId,
          reason: err instanceof Error ? err.message : 'Unknown error',
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
    const parentId = await this.resolvePath(tokens, path);

    const response = await providerFetch(this.id, `${UPLOAD_API}/files`, {
      method: 'POST',
      headers: {
        ...this.auth(tokens),
        'content-type': 'application/json',
        'x-upload-content-type': meta.mimeType,
        'x-upload-content-length': String(meta.sizeBytes),
      },
      query: { uploadType: 'resumable', supportsAllDrives: true, fields: FILE_FIELDS },
      body: JSON.stringify({ name: meta.name, parents: [parentId] }),
    });

    const uploadUrl = response.headers.get('location');
    if (!uploadUrl) {
      throw new ProviderError(this.id, 502, 'Drive did not return a resumable upload URL');
    }

    return {
      provider: this.id,
      remoteSessionId: uploadUrl,
      uploadUrl,
      chunkSize: CHUNK_SIZE,
      state: { offset: 0, totalBytes: meta.sizeBytes, virtualPath: joinPath(path, meta.name) },
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

    // 308 is Drive saying "chunk stored, keep going" - not an error.
    if (response.status === 308) return { done: false };

    if (!response.ok) {
      throw new ProviderError(this.id, response.status, await response.text().catch(() => 'Upload failed'));
    }

    const file = (await response.json()) as DriveFile;
    return { done: true, file: toOrbitFile(file, state.virtualPath) };
  }

  // --- sync ---------------------------------------------------------------

  override async listChangesSince(tokens: AccountTokens, cursor: string | null): Promise<DeltaResult> {
    let pageToken = cursor;

    if (!pageToken) {
      const start = await providerJson<{ startPageToken: string }>(
        this.id,
        `${API}/changes/startPageToken`,
        { headers: this.auth(tokens), query: { supportsAllDrives: true } },
      );
      // A fresh cursor establishes "from now on"; there is no delta to report yet.
      return { changed: [], deletedRemoteIds: [], cursor: start.startPageToken, hasMore: false };
    }

    const page = await providerJson<{
      changes?: Array<{ fileId: string; removed?: boolean; file?: DriveFile }>;
      nextPageToken?: string;
      newStartPageToken?: string;
    }>(this.id, `${API}/changes`, {
      headers: this.auth(tokens),
      query: {
        pageToken,
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`,
        pageSize: 500,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      },
    });

    const changed: OrbitFile[] = [];
    const deletedRemoteIds: string[] = [];

    for (const change of page.changes ?? []) {
      // A trashed file is a deletion as far as the mirror is concerned.
      if (change.removed || !change.file || change.file.trashed) {
        deletedRemoteIds.push(change.fileId);
        continue;
      }
      changed.push(toOrbitFile(change.file, `/${change.file.name}`));
    }

    return {
      changed,
      deletedRemoteIds,
      cursor: page.nextPageToken ?? page.newStartPageToken ?? pageToken,
      hasMore: Boolean(page.nextPageToken),
    };
  }

  // --- internals ----------------------------------------------------------

  /**
   * Reads one file, following a shortcut to whatever it points at. Callers get
   * the target's metadata but keep the id they asked about, so an operation on
   * the pointer still acts on the pointer.
   */
  private async fetchFile(
    tokens: AccountTokens,
    remoteId: string,
    fields: string,
  ): Promise<DriveFile> {
    const file = await providerJson<DriveFile>(this.id, `${API}/files/${encodeURIComponent(remoteId)}`, {
      headers: this.auth(tokens),
      // Resolving a shortcut needs these two whether or not the caller asked.
      query: { fields: withFields(fields, 'mimeType', 'shortcutDetails'), supportsAllDrives: true },
    });

    const targetId = file.mimeType === GOOGLE_DRIVE_SHORTCUT_MIME ? file.shortcutDetails?.targetId : undefined;
    if (!targetId) return file;

    const target = await providerJson<DriveFile>(this.id, `${API}/files/${encodeURIComponent(targetId)}`, {
      headers: this.auth(tokens),
      query: { fields, supportsAllDrives: true },
    });

    return { ...target, id: file.id, name: file.name, shortcutDetails: { targetId, targetMimeType: target.mimeType } };
  }

  private auth(tokens: AccountTokens): Record<string, string> {
    if (!tokens.accessToken) throw new ProviderError(this.id, 401, 'No access token');
    return { authorization: `Bearer ${tokens.accessToken}` };
  }

  /**
   * Drive addresses files by id, not path, so a virtual path is resolved by
   * walking from the root one segment at a time. Callers that already hold an
   * id should use it directly - this is for the browse case.
   */
  private async resolvePath(tokens: AccountTokens, path: string): Promise<string> {
    const segments = normalisePath(path).split('/').filter(Boolean);
    let parentId = 'root';

    for (const segment of segments) {
      const page = await providerJson<DriveList>(this.id, `${API}/files`, {
        headers: this.auth(tokens),
        query: {
          q: [
            `'${parentId}' in parents`,
            `name = '${escapeQuery(segment)}'`,
            // A shortcut to a folder is a folder as far as browsing is concerned.
            `(mimeType = '${GOOGLE_DRIVE_FOLDER_MIME}' or (mimeType = '${GOOGLE_DRIVE_SHORTCUT_MIME}' and shortcutDetails.targetMimeType = '${GOOGLE_DRIVE_FOLDER_MIME}'))`,
            'trashed = false',
          ].join(' and '),
          fields: 'files(id,mimeType,shortcutDetails(targetId))',
          pageSize: 1,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        },
      });

      const match = page.files?.[0];
      if (!match) throw new ProviderError(this.id, 404, `No folder at ${path}`);
      // Walk through the shortcut, not into it.
      parentId = match.shortcutDetails?.targetId ?? match.id;
    }

    return parentId;
  }
}

/** Google's own formats have no bytes to download, so they are exported instead. */
const EXPORT_FORMATS: Record<string, string> = {
  'application/vnd.google-apps.document':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.google-apps.spreadsheet':
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.google-apps.presentation':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.google-apps.drawing': 'image/png',
  'application/vnd.google-apps.script': 'application/vnd.google-apps.script+json',
};

export function toOrbitFile(file: DriveFile, virtualPath: string): OrbitFile {
  const shortcut = file.mimeType === GOOGLE_DRIVE_SHORTCUT_MIME ? file.shortcutDetails : undefined;
  // A shortcut must behave like whatever it points at, or a shortcut to a
  // folder shows up as an unopenable zero-byte file.
  const effectiveMime = shortcut?.targetMimeType ?? file.mimeType;

  return {
    remoteId: file.id,
    name: file.name,
    virtualPath,
    mimeType: effectiveMime,
    // Google-native documents report no size at all.
    sizeBytes: Number(file.size ?? 0),
    isFolder: effectiveMime === GOOGLE_DRIVE_FOLDER_MIME,
    starred: Boolean(file.starred),
    modifiedAt: file.modifiedTime ?? new Date(0).toISOString(),
    checksum: file.md5Checksum,
    shortcutTargetId: shortcut?.targetId,
  };
}

/** Adds fields to a Drive field list without repeating any. */
export function withFields(fields: string, ...extra: string[]): string {
  const present = new Set(fields.split(',').map((field) => field.trim()).filter(Boolean));
  for (const field of extra) present.add(field);
  return [...present].join(',');
}

/** Drive's query language delimits with single quotes and escapes with a backslash. */
export function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
