/**
 * The single contract every storage provider is normalised to.
 * Adding a provider means implementing this interface and nothing else —
 * no route, view, or engine in Orbit may special-case a provider id.
 */

export const PROVIDER_IDS = [
  'google_drive',
  'onedrive',
  'dropbox',
  'mega',
  'pcloud',
  's3',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export type AuthType = 'oauth' | 'account_password' | 'access_key';

/** Decrypted credential material handed to an adapter at call time. */
export interface AccountTokens {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  /** Account/password providers (Mega, pCloud legacy). */
  username?: string;
  password?: string;
  /** S3-compatible providers. */
  accessKeyId?: string;
  secretAccessKey?: string;
  endpoint?: string;
  region?: string;
  bucket?: string;
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
  usedBytes: number;
  totalBytes: number;
}

export interface DeltaResult {
  changed: OrbitFile[];
  deletedRemoteIds: string[];
  cursor: string | null;
  hasMore: boolean;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly authType: AuthType;
  readonly displayName: string;
  /** Capabilities the UI reads to hide unsupported actions instead of failing them. */
  readonly capabilities: {
    star: boolean;
    sharedWithMe: boolean;
    delta: boolean;
    resumableUpload: boolean;
    rangeRequests: boolean;
  };

  connect(input: ConnectInput): Promise<AccountTokens>;
  refreshToken(tokens: AccountTokens): Promise<AccountTokens>;

  listFolder(tokens: AccountTokens, path: string, pageToken?: string): Promise<OrbitFilePage>;
  getFileMeta(tokens: AccountTokens, remoteId: string): Promise<OrbitFile>;
  getFileStream(tokens: AccountTokens, remoteId: string, range?: ByteRange): Promise<FileStreamResult>;

  createFolder(tokens: AccountTokens, path: string, name: string): Promise<OrbitFile>;
  rename(tokens: AccountTokens, remoteId: string, newName: string): Promise<void>;
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
