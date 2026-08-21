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
  ProviderAdapter,
  ProviderCapabilities,
  ProviderId,
  Quota,
  SearchQuery,
  UploadMeta,
  UploadSession,
  WorkspaceView,
} from '@orbit/shared-types';

export class NotImplementedError extends Error {
  constructor(provider: ProviderId, method: string) {
    super(`${provider}: ${method}() is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}

/** Raised when a provider call fails; keeps token material out of the message. */
export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly status: number,
    message: string,
  ) {
    super(`${provider} [${status}]: ${message}`);
    this.name = 'ProviderError';
  }
}

/**
 * Whether a failed refresh means the grant is genuinely gone, as opposed to the
 * network having a bad moment.
 *
 * This distinction is what stops a transient blip from forcing the user to
 * reconnect an account that is still perfectly valid. Only an explicit refusal
 * from the provider counts: `invalid_grant` (revoked, expired, or the user
 * changed their password), or a 400/401 on the token endpoint. A timeout, a
 * reset connection, or a 5xx is the provider having trouble, not a dead grant.
 */
export function isGrantRevoked(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  if (/invalid_grant|invalid_token|token has been (expired|revoked)/i.test(err.message)) return true;
  return err.status === 400 || err.status === 401;
}

/** Re-exported so adapters import their capability shape from one place. */
export type AdapterCapabilities = ProviderCapabilities;

/**
 * Every adapter extends this. Unimplemented methods throw loudly rather than
 * silently returning empty data, so a half-built adapter can never look healthy.
 */
export abstract class BaseAdapter implements ProviderAdapter {
  abstract readonly id: ProviderId;
  abstract readonly authType: AuthType;
  abstract readonly displayName: string;
  abstract readonly capabilities: AdapterCapabilities;

  protected unsupported(method: string): never {
    throw new NotImplementedError(this.id, method);
  }

  connect(_input: ConnectInput): Promise<AccountTokens> {
    return this.unsupported('connect');
  }
  refreshToken(_tokens: AccountTokens): Promise<AccountTokens> {
    return this.unsupported('refreshToken');
  }
  listFolder(_tokens: AccountTokens, _path: string, _pageToken?: string): Promise<OrbitFilePage> {
    return this.unsupported('listFolder');
  }
  listAllFiles(_tokens: AccountTokens, _pageToken?: string): Promise<OrbitFilePage> {
    return this.unsupported('listAllFiles');
  }
  listView(_tokens: AccountTokens, _view: WorkspaceView, _pageToken?: string): Promise<OrbitFilePage> {
    return this.unsupported('listView');
  }
  search(_tokens: AccountTokens, _query: SearchQuery, _pageToken?: string): Promise<OrbitFilePage> {
    return this.unsupported('search');
  }
  getFileMeta(_tokens: AccountTokens, _remoteId: string): Promise<OrbitFile> {
    return this.unsupported('getFileMeta');
  }
  getFileStream(_tokens: AccountTokens, _remoteId: string, _range?: ByteRange): Promise<FileStreamResult> {
    return this.unsupported('getFileStream');
  }
  /** Absent rather than unsupported: a missing thumbnail is normal, not an error. */
  getThumbnail(
    _tokens: AccountTokens,
    _remoteId: string,
    _size?: number,
  ): Promise<FileStreamResult | null> {
    return Promise.resolve(null);
  }
  createFolder(_tokens: AccountTokens, _path: string, _name: string): Promise<OrbitFile> {
    return this.unsupported('createFolder');
  }
  rename(_tokens: AccountTokens, _remoteId: string, _newName: string): Promise<void> {
    return this.unsupported('rename');
  }
  remove(_tokens: AccountTokens, _remoteIds: string[]): Promise<BulkResult> {
    return this.unsupported('remove');
  }
  star(_tokens: AccountTokens, _remoteId: string, _starred: boolean): Promise<void> {
    return this.unsupported('star');
  }
  initUpload(_tokens: AccountTokens, _path: string, _meta: UploadMeta): Promise<UploadSession> {
    return this.unsupported('initUpload');
  }
  uploadChunk(
    _session: UploadSession,
    _chunk: Uint8Array,
    _onProgress: (uploadedBytes: number) => void,
  ): Promise<{ done: boolean; file?: OrbitFile }> {
    return this.unsupported('uploadChunk');
  }
  getQuota(_tokens: AccountTokens): Promise<Quota> {
    return this.unsupported('getQuota');
  }
  listChangesSince(_tokens: AccountTokens, _cursor: string | null): Promise<DeltaResult> {
    return this.unsupported('listChangesSince');
  }
}

/** Normalise any path into Orbit's virtual-path form: leading slash, no trailing slash. */
export function normalisePath(path: string): string {
  const cleaned = `/${path}`.replace(/\/+/g, '/').replace(/\/$/, '');
  return cleaned === '' ? '/' : cleaned;
}

export function joinPath(parent: string, name: string): string {
  return normalisePath(`${parent}/${name}`);
}
