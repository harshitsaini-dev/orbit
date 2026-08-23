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
  | { type: 'transfer:done'; id: string }
  /*
   * One half of a direct transfer talking to the other.
   *
   * The server never reads the payload - it is somebody's session description
   * or an ICE candidate, and Orbit is only the post office. Kept opaque on
   * purpose: a relay that understands what it carries is a relay somebody will
   * later be tempted to log.
   */
  | { type: 'p2p:signal'; handoff: string; payload: unknown }
  /** The other side arrived, or left before the transfer finished. */
  | { type: 'p2p:peer'; handoff: string; present: boolean }
  /** A third party tried to join a handoff that already has two ends. */
  | { type: 'p2p:full'; handoff: string };

/** Client -> server WebSocket frames. */
export type ClientEvent =
  | { type: 'subscribe'; channel: string }
  | { type: 'unsubscribe'; channel: string }
  | { type: 'ping' }
  | { type: 'p2p:signal'; handoff: string; payload: unknown };
