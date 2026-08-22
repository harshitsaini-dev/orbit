import type { OrbitFile } from './provider.js';

export interface ApiError {
  error: { code: string; message: string };
}

export interface Paginated<T> {
  items: T[];
  nextCursor?: string;
}

/** A mirrored file enriched with the account it came from. */
export interface WorkspaceFile extends OrbitFile {
  id: string;
  accountId: string;
  provider: string;
  accountNickname: string;
}

export type UploadStatus = 'queued' | 'uploading' | 'complete' | 'error';

export interface UploadInitResponse {
  uploadId: string;
  accountId: string;
  chunkSize: number;
  wsChannel: string;
}

/** Server -> client WebSocket frames. */
export type ServerEvent =
  | { type: 'upload:progress'; uploadId: string; uploadedBytes: number; totalBytes: number; pct: number }
  | { type: 'upload:complete'; uploadId: string; file: WorkspaceFile }
  | { type: 'upload:error'; uploadId: string; message: string }
  | { type: 'sync:status'; accountId: string; status: 'running' | 'ok' | 'error'; deltaCount?: number }
  // A transfer outlives the request that started it, so its progress can only
  // reach the browser this way.
  | { type: 'transfer:progress'; id: string; transferred: number }
  | { type: 'transfer:done'; id: string };

/** Client -> server WebSocket frames. */
export type ClientEvent =
  | { type: 'subscribe'; channel: string }
  | { type: 'unsubscribe'; channel: string }
  | { type: 'ping' };
