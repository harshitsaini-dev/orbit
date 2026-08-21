import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';
import { directoryOf, uploadFile, type UploadItem } from '../lib/upload.js';

/**
 * The upload queue.
 *
 * Files go up one at a time rather than in parallel. A browser will happily
 * open six connections at once, but a provider rate-limits per account, and six
 * uploads each crawling is worse than one finishing — the queue also keeps the
 * progress figures meaningful.
 */
export function UploadPanel({
  accountId,
  path,
  items,
  setItems,
  onComplete,
}: {
  accountId: string;
  path: string;
  items: UploadItem[];
  setItems: React.Dispatch<React.SetStateAction<UploadItem[]>>;
  onComplete: () => void;
}) {
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const queueRef = useRef<Array<{ item: UploadItem; file: File }>>([]);

  const update = useCallback(
    (id: string, changes: Partial<UploadItem>) => {
      setItems((current) => current.map((item) => (item.id === id ? { ...item, ...changes } : item)));
    },
    [setItems],
  );

  /** Folders in a dropped tree have to exist before their files can land in them. */
  const ensureFolders = useCallback(
    async (relativePaths: string[]) => {
      const needed = new Set<string>();
      for (const relativePath of relativePaths) {
        const directory = directoryOf(relativePath);
        if (!directory) continue;

        // Every ancestor, so /a/b/c creates a, a/b, then a/b/c.
        const parts = directory.split('/');
        for (let i = 1; i <= parts.length; i += 1) needed.add(parts.slice(0, i).join('/'));
      }

      // Shortest first, so a parent always exists before its child.
      for (const directory of [...needed].sort((a, b) => a.split('/').length - b.split('/').length)) {
        const parts = directory.split('/');
        const name = parts.pop()!;
        const parent = `${path.replace(/\/$/, '')}/${parts.join('/')}`.replace(/\/+/g, '/') || '/';

        try {
          await api('/api/files/folder', { method: 'POST', body: { accountId, path: parent, name } });
        } catch {
          // Most likely it already exists, which is exactly what was wanted.
        }
      }
    },
    [accountId, path],
  );

  const start = useCallback(async () => {
    if (running) return;
    setRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await ensureFolders(queueRef.current.map(({ item }) => item.relativePath));

      for (const { item, file } of queueRef.current) {
        if (controller.signal.aborted) {
          update(item.id, { state: 'cancelled' });
          continue;
        }

        update(item.id, { state: 'uploading' });

        const directory = directoryOf(item.relativePath);
        const target = directory
          ? `${path.replace(/\/$/, '')}/${directory}`.replace(/\/+/g, '/')
          : path;

        try {
          await uploadFile({
            accountId,
            path: target,
            file,
            signal: controller.signal,
            onProgress: (uploadedBytes) => update(item.id, { uploadedBytes }),
          });
          update(item.id, { state: 'done', uploadedBytes: item.sizeBytes });
        } catch (err) {
          if ((err as Error).name === 'AbortError') {
            update(item.id, { state: 'cancelled' });
          } else {
            update(item.id, {
              state: 'error',
              error: err instanceof ApiError ? err.message : (err as Error).message,
            });
          }
        }
      }
    } finally {
      queueRef.current = [];
      abortRef.current = null;
      setRunning(false);
      onComplete();
    }
  }, [accountId, ensureFolders, onComplete, path, running, update]);

  // Anything newly queued starts as soon as the current run is free.
  useEffect(() => {
    const queued = items.filter((item) => item.state === 'queued');
    if (queued.length === 0 || running) return;

    queueRef.current = queued
      .map((item) => ({ item, file: fileFor(item.id) }))
      .filter((entry): entry is { item: UploadItem; file: File } => entry.file !== undefined);

    if (queueRef.current.length > 0) void start();
  }, [items, running, start]);

  if (items.length === 0) return null;

  const active = items.filter((item) => item.state === 'uploading' || item.state === 'queued');
  const failed = items.filter((item) => item.state === 'error');
  const totalBytes = items.reduce((sum, item) => sum + item.sizeBytes, 0);
  const doneBytes = items.reduce((sum, item) => sum + item.uploadedBytes, 0);

  return (
    <section className="clay" style={{ padding: '1rem 1.1rem', display: 'grid', gap: 10 }} data-testid="upload-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 14 }}>
          {active.length > 0
            ? `Uploading ${active.length} of ${items.length}`
            : failed.length > 0
              ? `${failed.length} of ${items.length} failed`
              : `Uploaded ${items.length} ${items.length === 1 ? 'file' : 'files'}`}
        </strong>

        <div style={{ display: 'flex', gap: 8 }}>
          {active.length > 0 && (
            <button
              type="button"
              className="clay-button"
              style={{ padding: '0.3rem 0.9rem', fontSize: 12 }}
              onClick={() => abortRef.current?.abort()}
            >
              Cancel
            </button>
          )}
          {active.length === 0 && (
            <button
              type="button"
              className="clay-button"
              style={{ padding: '0.3rem 0.9rem', fontSize: 12 }}
              onClick={() => setItems([])}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {totalBytes > 0 && (
        <div className="clay-sunken" style={{ height: 8, borderRadius: 'var(--radius-pill)', overflow: 'hidden' }}>
          <div
            style={{
              width: `${Math.min(100, (doneBytes / totalBytes) * 100)}%`,
              height: '100%',
              background: failed.length > 0 ? 'var(--warning)' : 'var(--accent)',
              transition: 'width var(--dur-fast) linear',
            }}
          />
        </div>
      )}

      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 4, maxHeight: 190, overflow: 'auto' }}>
        {items.map((item) => (
          <li key={item.id} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13, minWidth: 0 }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.relativePath}
            </span>
            <span style={{ color: item.state === 'error' ? 'var(--danger)' : 'var(--text-muted)', fontSize: 12, whiteSpace: 'nowrap' }}>
              {item.state === 'error'
                ? (item.error ?? 'Failed')
                : item.state === 'done'
                  ? 'Done'
                  : item.state === 'cancelled'
                    ? 'Cancelled'
                    : item.sizeBytes > 0
                      ? `${Math.round((item.uploadedBytes / item.sizeBytes) * 100)}%`
                      : '…'}
            </span>
            <span style={{ color: 'var(--text-muted)', fontSize: 12, whiteSpace: 'nowrap' }}>
              {formatBytes(item.sizeBytes)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The File objects themselves are held outside React state: they are not
 * serialisable, and putting them in state would mean copying a handle to
 * potentially gigabytes on every render.
 */
const fileRegistry = new Map<string, File>();

export function registerFile(id: string, file: File): void {
  fileRegistry.set(id, file);
}

function fileFor(id: string): File | undefined {
  return fileRegistry.get(id);
}

export function forgetFiles(ids: string[]): void {
  for (const id of ids) fileRegistry.delete(id);
}
