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
import { BaseAdapter, ProviderError, joinPath, normalisePath, type AdapterCapabilities } from '../base.js';
import { providerFetch, providerJson } from '../http.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const GOOGLE_DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * The folder shared drives live behind.
 *
 * Not a real folder anywhere: Drive has no such thing, so Orbit synthesises one
 * to hold roots that are not children of anything. The id is deliberately not a
 * plausible Drive id, so it cannot collide with one.
 */
export const SHARED_DRIVES = 'Shared drives';
const SHARED_DRIVES_ID = 'orbit:shared-drives';
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
    trash: true,
    purgeTrash: true,
    relocate: true,
    thumbnails: true,
    search: true,
    fullTextSearch: true,
    recentView: true,
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

    // Answered without a query: there is no such folder to list.
    if (folderId === SHARED_DRIVES_ID) {
      return {
        files: (await this.sharedDrives(tokens)).map((drive) =>
          toOrbitFile(drive, joinPath(parent, drive.name ?? '')),
        ),
      };
    }

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

    let files = page.files ?? [];

    /*
     * Shared drives sit beside My Drive, not inside it.
     *
     * `includeItemsFromAllDrives` makes their *contents* visible once the
     * parent is known, which is why files in one have always worked - but a
     * shared drive is its own root and is not a child of `root`, so a Workspace
     * user's team drives were absent from the top level with nothing to say
     * they existed.
     *
     * They go behind one folder rather than being listed at the root directly.
     * A shared drive is not in My Drive, and putting a team drive among
     * somebody's personal folders says that it is - which is wrong about who
     * owns it, wrong about who else can see it, and wrong about whose quota it
     * counts against. Google's own client draws the same line.
     */
    if (parent === '/' && !pageToken && (await this.sharedDrives(tokens)).length > 0) {
      files = [
        {
          id: SHARED_DRIVES_ID,
          name: SHARED_DRIVES,
          mimeType: GOOGLE_DRIVE_FOLDER_MIME,
        },
        ...files,
      ];
    }


    // Drive answers a listing of a folder the caller cannot see with an empty
    // list rather than an error, so a shortcut whose target was deleted or
    // un-shared looks exactly like an empty folder - and the first sign of
    // trouble is an upload into it failing for no visible reason. An empty
    // result is rare and cheap to check, so it is checked.
    if (files.length === 0 && !pageToken) await this.assertReachable(tokens, folderId, parent);

    return {
      files: files.map((file) => toOrbitFile(file, joinPath(parent, file.name))),
      nextPageToken: page.nextPageToken,
    };
  }

  /**
   * The shared drives this account can see, as folder entries.
   *
   * A personal Google account has none and the call returns an empty list; some
   * accounts refuse it outright, which is not an error worth surfacing - it
   * means "no shared drives", and My Drive should still list.
   */
  private async sharedDrives(tokens: AccountTokens): Promise<DriveFile[]> {
    try {
      const page = await providerJson<{ drives?: Array<{ id: string; name: string }> }>(
        this.id,
        `${API}/drives`,
        {
          headers: this.auth(tokens),
          query: { pageSize: 100, fields: 'drives(id,name)' },
        },
      );

      return (page.drives ?? []).map((drive) => ({
        id: drive.id,
        name: drive.name,
        mimeType: GOOGLE_DRIVE_FOLDER_MIME,
      }));
    } catch (err) {
      // Not fatal - My Drive should still list - but said out loud rather than
      // swallowed. A silent catch here means "no shared drives" and "the call
      // failed" look identical, and there is no way to tell which one is
      // happening from the outside.
      console.warn(
        'google_drive: could not list shared drives -',
        err instanceof Error ? err.message : err,
      );
      return [];
    }
  }

  /** Confirms a folder exists and is readable, for when a listing came back empty. */
  private async assertReachable(
    tokens: AccountTokens,
    folderId: string,
    path: string,
  ): Promise<void> {
    if (folderId === 'root') return;

    try {
      await providerJson<DriveFile>(this.id, `${API}/files/${folderId}`, {
        headers: this.auth(tokens),
        query: { fields: 'id', supportsAllDrives: true },
      });
    } catch (err) {
      if (err instanceof ProviderError && (err.status === 404 || err.status === 403)) {
        throw new ProviderError(
          this.id,
          404,
          `folder ${folderId} behind ${path} is unreachable`,
          `${path} points at something this account can no longer open. The original may have been deleted, or it may no longer be shared with you.`,
        );
      }
      throw err;
    }
  }

  /**
   * Every file in the account, flat. One query rather than one per folder,
   * which is the difference between a handful of requests and thousands on a
   * drive of any size. Folders are excluded: they hold no bytes and would
   * double-count against their contents.
   */
  /**
   * Everything in one shared drive.
   *
   * A shared drive is a root of its own, so `listAllFiles` - which asks for the
   * account's own corpus on purpose - does not reach it. `corpora: 'drive'`
   * with the drive's id does, in one flat pass rather than by walking folders.
   */
  async listAllUnder(
    tokens: AccountTokens,
    rootId: string,
    pageToken?: string,
  ): Promise<OrbitFilePage> {
    const page = await providerJson<DriveList>(this.id, `${API}/files`, {
      headers: this.auth(tokens),
      query: {
        q: `trashed = false and mimeType != '${GOOGLE_DRIVE_FOLDER_MIME}'`,
        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum)',
        pageSize: 1000,
        pageToken,
        corpora: 'drive',
        driveId: rootId,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      },
    });

    return {
      files: (page.files ?? []).map((file) => toOrbitFile(file, `/${file.name ?? ''}`)),
      nextPageToken: page.nextPageToken,
    };
  }

  override async listAllFiles(tokens: AccountTokens, pageToken?: string): Promise<OrbitFilePage> {
    const page = await providerJson<DriveList>(this.id, `${API}/files`, {
      headers: this.auth(tokens),
      query: {
        q: `trashed = false and mimeType != '${GOOGLE_DRIVE_FOLDER_MIME}'`,
        // Less than the full set, because asking for less makes each page
        // markedly cheaper on an account with a hundred thousand files - but
        // md5Checksum stays. It is what lets the mirror say two files are
        // definitely the same rather than probably, and leaving it out
        // downgraded every duplicate in an account to a guess.
        fields:
          'nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum,shortcutDetails(targetMimeType))',
        pageSize: 1000,
        pageToken,
        /*
         * The user's own corpus, deliberately - not every drive they can see.
         *
         * This feeds the mirror, which is what the storage breakdown, the
         * duplicate finder and search all read. Shared drive content is not
         * this account's: Google does not count it against the account's
         * allowance either, so pulling it in here made a 15 GB Drive report
         * a breakdown of storage it does not own and cannot free.
         *
         * Shared drives stay browsable; they are simply not part of what this
         * account has stored.
         */
        corpora: 'user',
        supportsAllDrives: true,
      },
    });

    return {
      files: (page.files ?? []).map((file) => toOrbitFile(file, `/${file.name}`)),
      nextPageToken: page.nextPageToken,
    };
  }

  /**
   * Recent, starred, and shared-with-me.
   *
   * None of these is a folder Orbit can walk to - each is a query Drive answers
   * itself - so they get one call rather than being synthesised from listings.
   * The virtual path is the file's name alone, because a file in these views can
   * live anywhere and resolving its real path would cost a request each.
   */
  override async listView(
    tokens: AccountTokens,
    view: WorkspaceView,
    pageToken?: string,
  ): Promise<OrbitFilePage> {
    const query: Record<string, string | number | boolean | undefined> = {
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    };

    if (view === 'starred') {
      query.q = 'starred = true and trashed = false';
      query.orderBy = 'name_natural';
    } else if (view === 'shared') {
      query.q = 'sharedWithMe = true and trashed = false';

      query.orderBy = 'sharedWithMeTime desc';
    } else {
      // Folders are excluded: "recent" means recent work, and a folder's
      // timestamp changes whenever anything inside it does.
      query.q = `trashed = false and mimeType != '${GOOGLE_DRIVE_FOLDER_MIME}'`;
      query.orderBy = 'modifiedTime desc';
    }

    const page = await providerJson<DriveList>(this.id, `${API}/files`, {
      headers: this.auth(tokens),
      query,
    });

    return {
      files: (page.files ?? []).map((file) => toOrbitFile(file, `/${file.name}`)),
      nextPageToken: page.nextPageToken,
    };
  }


  /**
   * Searches the whole account, the way a file manager does.
   *
   * Drive has no "everything under folder X" query - `in parents` matches only
   * direct children - so scoping to a subtree is done by resolving each result's
   * real path and keeping the ones beneath it. That resolution is wanted anyway:
   * a search result is far less useful without showing where the file lives.
   * Ancestors are cached per call, so a hundred results in the same few folders
   * cost a handful of requests rather than a hundred.
   */
  override async search(
    tokens: AccountTokens,
    query: SearchQuery,
    pageToken?: string,
  ): Promise<OrbitFilePage> {
    const clauses = ['trashed = false'];

    if (query.text?.trim()) {
      const needle = escapeQuery(query.text.trim());
      clauses.push(
        query.fullText
          ? `(name contains '${needle}' or fullText contains '${needle}')`
          : `name contains '${needle}'`,
      );
    }

    if (query.starredOnly) clauses.push('starred = true');
    if (query.ownedByMeOnly) clauses.push("'me' in owners");
    if (query.modifiedAfter) clauses.push(`modifiedTime > '${query.modifiedAfter}'`);

    const page = await providerJson<DriveList>(this.id, `${API}/files`, {
      headers: this.auth(tokens),
      query: {
        q: clauses.join(' and '),
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: 100,
        pageToken,
        orderBy: 'modifiedTime desc',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      },
    });

    const ancestors = new Map<string, { name: string; parent?: string }>();
    const files: OrbitFile[] = [];

    for (const raw of page.files ?? []) {
      const virtualPath = await this.resolveVirtualPath(tokens, raw, ancestors);
      const file = toOrbitFile(raw, virtualPath);

      // Size is not expressible in a Drive query, so it is applied here.
      if (query.minSizeBytes !== undefined && file.sizeBytes < query.minSizeBytes) continue;
      if (query.maxSizeBytes !== undefined && file.sizeBytes > query.maxSizeBytes) continue;

      if (query.underPath && query.underPath !== '/') {
        const scope = normalisePath(query.underPath);
        if (virtualPath !== scope && !virtualPath.startsWith(`${scope}/`)) continue;
      }

      files.push(file);
    }

    return { files, nextPageToken: page.nextPageToken };
  }

  /** Walks a file's parents to the root, caching every ancestor it sees. */
  private async resolveVirtualPath(
    tokens: AccountTokens,
    file: DriveFile,
    cache: Map<string, { name: string; parent?: string }>,
  ): Promise<string> {
    const segments: string[] = [];
    let parentId = file.parents?.[0];
    let hops = 0;

    // A depth cap: Drive is a graph, and a cycle would otherwise spin forever.
    while (parentId && hops < 24) {
      let entry = cache.get(parentId);

      if (!entry) {
        try {
          const parent = await providerJson<DriveFile>(
            this.id,
            `${API}/files/${encodeURIComponent(parentId)}`,
            { headers: this.auth(tokens), query: { fields: 'id,name,parents', supportsAllDrives: true } },
          );
          entry = { name: parent.name, parent: parent.parents?.[0] };
        } catch {
          // A parent we cannot read - someone else's folder, most often - ends
          // the walk rather than failing the whole search.
          break;
        }
        cache.set(parentId, entry);
      }

      // The root reports itself as "My Drive"; it is the path root, not a segment.
      if (!entry.parent) break;

      segments.unshift(entry.name);
      parentId = entry.parent;
      hops += 1;
    }

    return joinPath(`/${segments.join('/')}`, file.name);
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

  /**
   * Drive renders its own previews, including a frame from a video and a first
   * page for a document. Fetching it here rather than handing the client
   * `thumbnailLink` keeps the provider URL out of the browser - the same reason
   * file content is proxied - and the link is short-lived and needs the access
   * token anyway.
   */
  override async getThumbnail(
    tokens: AccountTokens,
    remoteId: string,
    size = 400,
  ): Promise<FileStreamResult | null> {
    const meta = await providerJson<DriveFile & { hasThumbnail?: boolean; thumbnailLink?: string }>(
      this.id,
      `${API}/files/${encodeURIComponent(remoteId)}`,
      {
        headers: this.auth(tokens),
        query: { fields: 'hasThumbnail,thumbnailLink,shortcutDetails', supportsAllDrives: true },
      },
    );

    if (!meta.hasThumbnail || !meta.thumbnailLink) return null;

    // The link carries its own size suffix; replacing it asks Drive for the
    // size actually wanted rather than scaling a wrong one in the browser.
    const url = meta.thumbnailLink.replace(/=s\d+(-c)?$/, `=s${size}`);

    const response = await providerFetch(this.id, url, { headers: this.auth(tokens) });
    if (!response.body) return null;

    const length = response.headers.get('content-length');
    return {
      stream: response.body,
      contentType: response.headers.get('content-type') ?? 'image/jpeg',
      contentLength: length ? Number(length) : undefined,
    };
  }

  override async getQuota(tokens: AccountTokens): Promise<Quota> {
    const about = await providerJson<{
      storageQuota?: {
        limit?: string;
        usage?: string;
        usageInDrive?: string;
        usageInDriveTrash?: string;
      };
    }>(this.id, `${API}/about`, {
      headers: this.auth(tokens),
      query: { fields: 'storageQuota' },
    });

    return {
      /*
       * Google's `usage` is the whole account: Drive, Gmail and Photos.
       *
       * It is the right figure for "how full is this account", because that is
       * what the allowance covers - but it is not the size of what Orbit can
       * see, which is Drive alone. `usageInDrive` is reported alongside so the
       * gap can be explained rather than looking like a miscount.
       *
       * Shared drives appear in neither: they are billed to the organisation.
       */
      usedBytes: Number(about.storageQuota?.usage ?? 0),
      usedInDriveBytes: Number(about.storageQuota?.usageInDrive ?? 0),
      trashedBytes: Number(about.storageQuota?.usageInDriveTrash ?? 0),
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
  /**
   * Drive has both operations natively, and neither moves any bytes.
   *
   * A move is a change of parent, which is why both the old and the new one
   * have to be named: a Drive file can legitimately sit in several folders at
   * once, so "remove from this one, add to that one" is the only unambiguous
   * way to say it.
   */
  override async relocate(
    tokens: AccountTokens,
    remoteId: string,
    targetPath: string,
    options: { copy: boolean },
  ): Promise<OrbitFile> {
    const targetId = await this.resolvePath(tokens, targetPath);

    if (options.copy) {
      const copied = await providerJson<DriveFile>(this.id, `${API}/files/${remoteId}/copy`, {
        method: 'POST',
        headers: { ...this.auth(tokens), 'content-type': 'application/json' },
        query: { fields: FILE_FIELDS, supportsAllDrives: true },
        body: JSON.stringify({ parents: [targetId] }),
      });

      return toOrbitFile(copied, joinPath(targetPath, copied.name ?? ''));
    }

    const current = await providerJson<DriveFile>(this.id, `${API}/files/${remoteId}`, {
      headers: this.auth(tokens),
      query: { fields: 'parents', supportsAllDrives: true },
    });

    const moved = await providerJson<DriveFile>(this.id, `${API}/files/${remoteId}`, {
      method: 'PATCH',
      headers: { ...this.auth(tokens), 'content-type': 'application/json' },
      query: {
        addParents: targetId,
        removeParents: (current.parents ?? []).join(','),
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      },
      body: '{}',
    });

    return toOrbitFile(moved, joinPath(targetPath, moved.name ?? ''));
  }

  /**
   * What Drive is holding in its bin.
   *
   * `trashed = true` with the user's own corpus: a shared drive has its own
   * bin, and mixing them would offer to restore a file into somebody else's
   * drive from a page about this account's storage.
   */
  async listTrash(tokens: AccountTokens, pageToken?: string): Promise<OrbitFilePage> {
    const page = await providerJson<DriveList>(this.id, `${API}/files`, {
      headers: this.auth(tokens),
      query: {
        q: 'trashed = true',
        fields: `nextPageToken,files(${FILE_FIELDS},trashedTime)`,
        pageSize: 200,
        pageToken,
        corpora: 'user',
        orderBy: 'recency desc',
        supportsAllDrives: true,
      },
    });

    return {
      files: (page.files ?? []).map((file) => toOrbitFile(file, `/${file.name ?? ''}`)),
      nextPageToken: page.nextPageToken,
    };
  }

  /**
   * Puts it back.
   *
   * Drive restores to wherever it came from, which is the only sensible answer
   * and not one Orbit gets to choose - so there is no destination to pass.
   */
  async restoreFromTrash(tokens: AccountTokens, remoteId: string): Promise<void> {
    await providerJson<DriveFile>(this.id, `${API}/files/${remoteId}`, {
      method: 'PATCH',
      headers: { ...this.auth(tokens), 'content-type': 'application/json' },
      query: { supportsAllDrives: true },
      body: JSON.stringify({ trashed: false }),
    });
  }

  /** Destroys it. There is no bin behind the bin. */
  async purgeFromTrash(tokens: AccountTokens, remoteId: string): Promise<void> {
    await providerFetch(this.id, `${API}/files/${remoteId}`, {
      method: 'DELETE',
      headers: this.auth(tokens),
      query: { supportsAllDrives: true },
    });
  }

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
    const pageToken = cursor;

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
      /*
       * The synthetic folder has no children in Drive, so it must never be
       * used as a parent in a query - Drive rejects the id outright, and the
       * throw skipped the fallback below that knows what to do with it. Its
       * children are the shared drives, resolved from their own list.
       */
      if (parentId === SHARED_DRIVES_ID) {
        const drive = (await this.sharedDrives(tokens)).find((d) => d.name === segment);
        if (!drive) throw new ProviderError(this.id, 404, `No shared drive named ${segment}`);
        parentId = drive.id;
        continue;
      }

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

      if (!match) {
        /*
         * "/Shared drives" is not a folder in Drive - Orbit synthesises it to
         * hold roots that are not children of anything. Recognised here rather
         * than up front so an ordinary path never pays for the check.
         */
        if (parentId === 'root' && segment === SHARED_DRIVES) {
          parentId = SHARED_DRIVES_ID;
          continue;
        }

        throw new ProviderError(this.id, 404, `No folder at ${path}`);
      }

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
