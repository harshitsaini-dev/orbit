import { api } from './api.js';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

export type UploadState = 'queued' | 'uploading' | 'done' | 'error' | 'cancelled';

export interface UploadItem {
  id: string;
  /** Path within the drop, so a dropped folder keeps its shape. */
  relativePath: string;
  name: string;
  sizeBytes: number;
  uploadedBytes: number;
  state: UploadState;
  error?: string;
}

interface InitResponse {
  uploadId: string;
  chunkSize: number;
  wsChannel: string;
}

/**
 * Uploads one file in chunks, straight through Orbit to the provider.
 *
 * Progress is reported from the client rather than read off the WebSocket:
 * the socket carries what the *server* has forwarded, which lags what the
 * browser has actually sent, and for a progress bar the earlier number is the
 * honest one to show.
 */
export async function uploadFile(options: {
  accountId: string;
  path: string;
  file: File;
  onProgress: (uploadedBytes: number) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { accountId, path, file, onProgress, signal } = options;

  const init = await api<InitResponse>('/api/uploads', {
    method: 'POST',
    body: {
      accountId,
      path,
      name: file.name,
      sizeBytes: file.size,
      mimeType: file.type || 'application/octet-stream',
    },
  });

  const chunkSize = init.chunkSize;
  let offset = 0;

  try {
    // An empty file still needs one request, or it would never be created.
    do {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const slice = file.slice(offset, Math.min(offset + chunkSize, file.size));
      const body = await slice.arrayBuffer();

      const response = await fetch(`${API_BASE}/api/uploads/${init.uploadId}/chunk`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/octet-stream' },
        body,
        signal,
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(payload?.error?.message ?? `Upload failed (${response.status})`);
      }

      offset += slice.size;
      onProgress(offset);

      const result = (await response.json()) as { done: boolean };
      if (result.done) return;
    } while (offset < file.size);
  } catch (err) {
    // Release the provider's session rather than leaving it dangling.
    void api(`/api/uploads/${init.uploadId}`, { method: 'DELETE' }).catch(() => undefined);
    throw err;
  }
}

/**
 * Flattens a drag-and-drop into files, keeping each one's path inside the drop.
 *
 * A dropped folder arrives as a directory entry rather than a file, so it has
 * to be walked; without this, dropping a folder silently uploads nothing.
 */
export async function filesFromDataTransfer(items: DataTransferItemList): Promise<Array<{ file: File; relativePath: string }>> {
  const entries: FileSystemEntry[] = [];

  for (const item of Array.from(items)) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }

  const collected: Array<{ file: File; relativePath: string }> = [];
  for (const entry of entries) await walk(entry, '', collected);
  return collected;
}

async function walk(
  entry: FileSystemEntry,
  prefix: string,
  out: Array<{ file: File; relativePath: string }>,
): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    out.push({ file, relativePath: prefix ? `${prefix}/${entry.name}` : entry.name });
    return;
  }

  if (!entry.isDirectory) return;

  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];

  // readEntries returns at most a batch at a time, so it is called until empty.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) break;
    children.push(...batch);
  }

  const next = prefix ? `${prefix}/${entry.name}` : entry.name;
  for (const child of children) await walk(child, next, out);
}

/** The folder part of a relative path, or empty for a file at the top level. */
export function directoryOf(relativePath: string): string {
  const parts = relativePath.split('/');
  parts.pop();
  return parts.join('/');
}
