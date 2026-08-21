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
  UploadMeta,
  UploadSession,
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
  getFileMeta(_tokens: AccountTokens, _remoteId: string): Promise<OrbitFile> {
    return this.unsupported('getFileMeta');
  }
  getFileStream(_tokens: AccountTokens, _remoteId: string, _range?: ByteRange): Promise<FileStreamResult> {
    return this.unsupported('getFileStream');
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
