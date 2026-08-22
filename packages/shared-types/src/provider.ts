/**
 * The single contract every storage provider is normalised to.
 * Adding a provider means implementing this interface and nothing else —
 * no route, view, or engine in Orbit may special-case a provider id.
 */

export const PROVIDER_IDS = [
  'google_drive',
  'onedrive',
  'dropbox',
  'pcloud',
  'azure_blob',
  'bunny',
  's3',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export type AuthType = 'oauth' | 'account_password' | 'access_key';

/** Decrypted credential material handed to an adapter at call time. */
export interface AccountTokens {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  /** Account/password providers, where one is ever added. */
  username?: string;
  password?: string;
  /** S3-compatible providers. */
  accessKeyId?: string;
  secretAccessKey?: string;
  endpoint?: string;
  region?: string;
  bucket?: string;
  forcePathStyle?: boolean;
  /** Google Cloud Storage service-account JSON. */
  serviceAccountJson?: string;
  /** Azure Blob Storage. */
  azureAccountName?: string;
  azureAccountKey?: string;
  azureContainer?: string;
  /** Bunny Edge Storage. */
  bunnyStorageZone?: string;
  bunnyAccessKey?: string;
  bunnyRegionHost?: string;
}

export interface OAuthCode {
  kind: 'oauth';
  code: string;
  redirectUri: string;
  codeVerifier?: string;
}

export interface Credentials {
  kind: 'credentials';
  values: Partial<AccountTokens>;
}

export type ConnectInput = OAuthCode | Credentials;

/** The normalised file shape. Every adapter maps its provider response into this. */
export interface OrbitFile {
  remoteId: string;
  name: string;
  /** Provider-agnostic path, e.g. "/Photos/2026/trip.jpg" */
  virtualPath: string;
  mimeType: string;
  sizeBytes: number;
  isFolder: boolean;
  starred: boolean;
  modifiedAt: string;
  checksum?: string;
  /**
   * When the provider put it in the bin, where it says.
   *
   * The useful number is not this but what follows from it - how long is left
   * before the provider destroys it on its own, which is the whole basis for
   * deciding whether to bother restoring something.
   */
  trashedAt?: string;

  /**
   * True when Orbit has a live public link for this file.
   *
   * Set by the listing route rather than by an adapter: it is a fact about
   * Orbit, not about the provider - a file can be shared inside Google Drive
   * and not shared through Orbit, and the two mean different things.
   */
  shared?: boolean;
  /**
   * Set when this entry points at another one (a Drive shortcut, and the same
   * idea elsewhere). Content and navigation follow the target; rename, delete
   * and star act on the pointer itself.
   */
  shortcutTargetId?: string;
}

/**
 * The cross-cutting views. Each is a query the provider answers itself rather
 * than a folder Orbit can walk to, so it needs its own call.
 */
export const WORKSPACE_VIEWS = ['recent', 'starred', 'shared'] as const;
export type WorkspaceView = (typeof WORKSPACE_VIEWS)[number];

/**
 * A search across a whole account, not a filter over one loaded folder.
 *
 * Every field is optional and they compose: text plus a type plus a date is one
 * query, not three. Providers apply what they can server-side and Orbit filters
 * the rest, so the same query means the same thing everywhere.
 */
export interface SearchQuery {
  /** Matched against the file name. */
  text?: string;
  /** Also match the file's contents, where the provider can. */
  fullText?: boolean;
  /** Restrict to these categories; empty or absent means any. */
  categories?: string[];
  /** ISO timestamp; only files changed since. */
  modifiedAfter?: string;
  minSizeBytes?: number;
  maxSizeBytes?: number;
  starredOnly?: boolean;
  /** Exclude files owned by other people. */
  ownedByMeOnly?: boolean;
  /** Limit to one folder and everything beneath it. */
  underPath?: string;
}

export interface OrbitFilePage {
  files: OrbitFile[];
  nextPageToken?: string;
}

export interface ByteRange {
  start: number;
  end?: number;
}

export interface FileStreamResult {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  contentLength?: number;
  /** Set when the adapter honoured a range request. */
  contentRange?: string;
}

export interface UploadMeta {
  name: string;
  sizeBytes: number;
  mimeType: string;
}

export interface UploadSession {
  provider: ProviderId;
  /** Provider-side resumable/multipart handle. */
  remoteSessionId: string;
  uploadUrl?: string;
  chunkSize: number;
  state?: Record<string, unknown>;
}

export interface BulkResult {
  succeeded: string[];
  failed: Array<{ remoteId: string; reason: string }>;
}

export interface Quota {
  /**
   * Everything the allowance covers.
   *
   * For Google that is Drive, Gmail and Photos together - which is the right
   * answer to "how full is this account" and the wrong one to "how big are the
   * files Orbit can see". The two differ by however much mail and how many
   * photos there are, and without saying so the gap looks like a miscount.
   */
  usedBytes: number;
  /**
   * Just the part Orbit can browse, where the provider separates it. Undefined
   * where the provider has nothing else in the same allowance to separate from.
   */
  usedInDriveBytes?: number;
  /** Deleted but not yet purged, which still counts against the allowance. */
  trashedBytes?: number;
  totalBytes: number;
}

export interface DeltaResult {
  changed: OrbitFile[];
  deletedRemoteIds: string[];
  cursor: string | null;
  hasMore: boolean;
}

export interface ProviderCapabilities {
  star: boolean;
  sharedWithMe: boolean;
  delta: boolean;
  resumableUpload: boolean;
  rangeRequests: boolean;
  /** Object stores have no real folders; Orbit synthesises them from key prefixes. */
  nativeFolders: boolean;
  /**
   * Whether a delete goes to a bin the file can be brought back from.
   *
   * Separate from `purgeTrash` because the two are separate promises and
   * providers keep them apart: Dropbox holds deleted files for thirty days and
   * will restore one, but only a business plan may destroy one early. Saying
   * "there is a bin" and "you may empty it" with one flag would offer a button
   * that fails on most accounts.
   */
  trash: boolean;
  /** Whether a file in the bin can be destroyed before the provider expires it. */
  purgeTrash: boolean;
  /**
   * Whether a file can be moved or copied to another folder **within the same
   * account**, without the bytes travelling through Orbit.
   *
   * Every provider that has this does it server-side in one call, which is why
   * it is worth having at all: the alternative is a download and a re-upload of
   * a file that never needed to leave the provider.
   */
  relocate: boolean;
  /** Whether the provider reports a total allowance, or only bytes used. */
  reportsQuota: boolean;
  /**
   * Whether every file can be enumerated in one flat, paginated pass. Needed
   * for the storage breakdown, and by the sync engine for providers with no
   * delta feed. Walking the folder tree instead would cost one request per
   * folder.
   */
  flatEnumeration: boolean;
  /** Whether the provider can return files ordered by when they last changed. */
  recentView: boolean;
  /** Whether the provider renders preview images Orbit can proxy. */
  thumbnails: boolean;
  /** Whether the provider can search its own contents, rather than Orbit paging everything. */
  search: boolean;
  /** Whether that search can reach inside file contents, not just names. */
  fullTextSearch: boolean;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly authType: AuthType;
  readonly displayName: string;
  /** Capabilities the UI reads to hide unsupported actions instead of failing them. */
  readonly capabilities: ProviderCapabilities;

  connect(input: ConnectInput): Promise<AccountTokens>;
  refreshToken(tokens: AccountTokens): Promise<AccountTokens>;

  listFolder(tokens: AccountTokens, path: string, pageToken?: string): Promise<OrbitFilePage>;
  /** Every file in the account, flat and paginated. Gated by `flatEnumeration`. */
  listAllFiles(tokens: AccountTokens, pageToken?: string): Promise<OrbitFilePage>;
  /**
   * Recent, starred, or shared-with-me. Gated per view by the capabilities:
   * `recentView`, `star` and `sharedWithMe` respectively.
   */
  listView(tokens: AccountTokens, view: WorkspaceView, pageToken?: string): Promise<OrbitFilePage>;
  /** Searches the whole account. Gated by the `search` capability. */
  search(tokens: AccountTokens, query: SearchQuery, pageToken?: string): Promise<OrbitFilePage>;
  getFileMeta(tokens: AccountTokens, remoteId: string): Promise<OrbitFile>;
  getFileStream(tokens: AccountTokens, remoteId: string, range?: ByteRange): Promise<FileStreamResult>;
  /**
   * A small preview image, or null when the provider has none for this file.
   * Gated by the `thumbnails` capability.
   */
  getThumbnail(tokens: AccountTokens, remoteId: string, size?: number): Promise<FileStreamResult | null>;

  /**
   * Who the connected account belongs to, where the provider will say.
   *
   * Used for three things at connect time: labelling the connection with an
   * address rather than the provider's name, recognising a reconnection of an
   * account already here, and seeding an empty profile. Optional because an
   * object store has no identity to report - a bucket belongs to a key, not to
   * a person.
   */
  getAccountIdentity?(
    tokens: AccountTokens,
  ): Promise<{ email?: string; displayName?: string; photoUrl?: string }>;

  /**
   * Everything beneath one folder, flat, where the provider can answer that in
   * one pass rather than by walking the tree.
   *
   * Only Google Drive implements it, and only for a shared drive - which is a
   * root of its own and so is not covered by `listAllFiles`, which asks for the
   * account's own corpus. Optional because walking a folder tree a request at a
   * time is not a reasonable fallback: for anything worth asking about it is
   * hundreds of requests, and a caller is better off knowing it cannot be done.
   */
  listAllUnder?(
    tokens: AccountTokens,
    rootId: string,
    pageToken?: string,
  ): Promise<OrbitFilePage>;

  /**
   * What is in the bin. Gated by the `trash` capability.
   *
   * Paged like any other listing: a bin is where a folder somebody deleted by
   * accident went, and those are not small.
   */
  listTrash?(tokens: AccountTokens, pageToken?: string): Promise<OrbitFilePage>;
  /** Puts a file back where it was. Gated by `trash`. */
  restoreFromTrash?(tokens: AccountTokens, remoteId: string): Promise<void>;
  /**
   * Destroys a file in the bin, before the provider would have.
   *
   * Gated by `purgeTrash`, which is false on providers that keep a bin but do
   * not let an ordinary account empty it early.
   */
  purgeFromTrash?(tokens: AccountTokens, remoteId: string): Promise<void>;

  createFolder(tokens: AccountTokens, path: string, name: string): Promise<OrbitFile>;
  rename(tokens: AccountTokens, remoteId: string, newName: string): Promise<void>;
  /**
   * Moves or copies one file or folder to another folder in the same account.
   * Gated by the `relocate` capability.
   *
   * The provider does the work; nothing is downloaded and re-uploaded. Copying
   * across *different* accounts is the transfer engine's job and is a different
   * problem - there the bytes genuinely have to travel.
   */
  relocate(
    tokens: AccountTokens,
    remoteId: string,
    targetPath: string,
    options: { copy: boolean },
  ): Promise<OrbitFile>;
  remove(tokens: AccountTokens, remoteIds: string[]): Promise<BulkResult>;
  star(tokens: AccountTokens, remoteId: string, starred: boolean): Promise<void>;

  initUpload(tokens: AccountTokens, path: string, meta: UploadMeta): Promise<UploadSession>;
  uploadChunk(
    session: UploadSession,
    chunk: Uint8Array,
    onProgress: (uploadedBytes: number) => void,
  ): Promise<{ done: boolean; file?: OrbitFile }>;

  getQuota(tokens: AccountTokens): Promise<Quota>;
  listChangesSince(tokens: AccountTokens, cursor: string | null): Promise<DeltaResult>;
}
