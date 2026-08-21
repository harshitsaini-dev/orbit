import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, api } from './api.js';
import { directoryOf, uploadFile, type UploadItem } from './upload.js';

/**
 * The upload queue, held above the router.
 *
 * It used to live inside My Drive, which meant navigating to Quota mid-upload
 * unmounted the thing doing the uploading and the transfer died silently. An
 * upload is a background job: it should survive going to look at something
 * else, and it should be visible from wherever you end up.
 *
 * Files go up one at a time. A browser will happily open six connections, but
 * a provider rate-limits per account, and six uploads each crawling is worse
 * than one finishing.
 */

export interface QueuedFile {
  file: File;
  /** Path within the drop, so a dropped folder keeps its shape. */
  relativePath: string;
}

export interface UploadJob extends UploadItem {
  /** Where it is going, so the list means something away from that folder. */
  accountId: string;
  targetPath: string;
  /** Which service, e.g. "Google Drive" or "Cloudflare R2". */
  provider: string;
  /** The account or bucket within it. */
  destination: string;
}

interface UploadsContext {
  jobs: UploadJob[];
  enqueue: (
    files: QueuedFile[],
    target: { accountId: string; path: string; provider: string; label: string },
  ) => void;
  cancel: () => void;
  clearFinished: () => void;
  /** Fires when a batch finishes, so an open folder can refresh itself. */
  onFinished: (listener: () => void) => () => void;
  active: number;
  failed: number;
  /** 0 to 1 across everything still running, or null when nothing is. */
  progress: number | null;
}

const Context = createContext<UploadsContext | null>(null);

/**
 * The File objects themselves, outside React state.
 *
 * A File is a handle to something on disk, not data to render, and putting one
 * in state makes every progress tick copy an object that React then compares.
 */
const files = new Map<string, File>();

let counter = 0;
const nextId = () => `upload-${(counter += 1)}`;

export function UploadsProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listeners = useRef(new Set<() => void>());

  const update = useCallback((id: string, changes: Partial<UploadJob>) => {
    setJobs((current) => current.map((job) => (job.id === id ? { ...job, ...changes } : job)));
  }, []);

  const enqueue = useCallback<UploadsContext['enqueue']>((incoming, target) => {
    if (incoming.length === 0) return;

    const added = incoming.map(({ file, relativePath }) => {
      const id = nextId();
      files.set(id, file);
      return {
        id,
        relativePath,
        name: file.name,
        sizeBytes: file.size,
        uploadedBytes: 0,
        state: 'queued' as const,
        accountId: target.accountId,
        targetPath: target.path,
        provider: target.provider,
        destination: target.label,
      };
    });

    setJobs((current) => [...current, ...added]);
  }, []);

  /** Folders in a dropped tree have to exist before their files can land in them. */
  const ensureFolders = useCallback(async (batch: UploadJob[]) => {
    const needed = new Map<string, { accountId: string; path: string }>();

    for (const job of batch) {
      const directory = directoryOf(job.relativePath);
      if (!directory) continue;

      // Every ancestor, so a/b/c creates a, then a/b, then a/b/c.
      const parts = directory.split('/');
      for (let i = 1; i <= parts.length; i += 1) {
        const relative = parts.slice(0, i).join('/');
        needed.set(`${job.accountId}:${job.targetPath}:${relative}`, {
          accountId: job.accountId,
          path: `${job.targetPath.replace(/\/$/, '')}/${relative}`.replace(/\/+/g, '/'),
        });
      }
    }

    // Shortest first, so a parent always exists before its child.
    const ordered = [...needed.values()].sort(
      (a, b) => a.path.split('/').length - b.path.split('/').length,
    );

    for (const entry of ordered) {
      const parts = entry.path.split('/');
      const name = parts.pop()!;
      try {
        await api('/api/files/folder', {
          method: 'POST',
          body: { accountId: entry.accountId, path: parts.join('/') || '/', name },
        });
      } catch {
        // Most likely it exists already, which is exactly what was wanted.
      }
    }
  }, []);

  const run = useCallback(
    async (batch: UploadJob[]) => {
      setRunning(true);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await ensureFolders(batch);

        for (const job of batch) {
          const file = files.get(job.id);
          if (!file) {
            update(job.id, { state: 'error', error: 'The file is no longer available' });
            continue;
          }

          if (controller.signal.aborted) {
            update(job.id, { state: 'cancelled' });
            continue;
          }

          update(job.id, { state: 'uploading' });

          const directory = directoryOf(job.relativePath);
          const target = directory
            ? `${job.targetPath.replace(/\/$/, '')}/${directory}`.replace(/\/+/g, '/')
            : job.targetPath;

          try {
            await uploadFile({
              accountId: job.accountId,
              path: target,
              file,
              signal: controller.signal,
              onProgress: (uploadedBytes) => update(job.id, { uploadedBytes }),
            });
            update(job.id, { state: 'done', uploadedBytes: job.sizeBytes });
          } catch (err) {
            if ((err as Error).name === 'AbortError') {
              update(job.id, { state: 'cancelled' });
            } else {
              update(job.id, {
                state: 'error',
                error: err instanceof ApiError ? err.message : (err as Error).message,
              });
            }
          } finally {
            // The handle is no use once the job has stopped, and holding it
            // keeps the whole file pinned for as long as the row is on screen.
            files.delete(job.id);
          }
        }
      } finally {
        abortRef.current = null;
        setRunning(false);
        for (const listener of listeners.current) listener();
      }
    },
    [ensureFolders, update],
  );

  // Anything newly queued starts as soon as the current run is free.
  useEffect(() => {
    if (running) return;
    const queued = jobs.filter((job) => job.state === 'queued');
    if (queued.length > 0) void run(queued);
  }, [jobs, running, run]);

  const value = useMemo<UploadsContext>(() => {
    const active = jobs.filter((job) => job.state === 'uploading' || job.state === 'queued');
    const failed = jobs.filter((job) => job.state === 'error');

    const total = active.reduce((sum, job) => sum + job.sizeBytes, 0);
    const done = active.reduce((sum, job) => sum + job.uploadedBytes, 0);

    return {
      jobs,
      enqueue,
      cancel: () => abortRef.current?.abort(),
      clearFinished: () =>
        setJobs((current) => current.filter((job) => job.state === 'uploading' || job.state === 'queued')),
      onFinished: (listener) => {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
      active: active.length,
      failed: failed.length,
      progress: active.length === 0 ? null : total > 0 ? done / total : 0,
    };
  }, [jobs, enqueue]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useUploads(): UploadsContext {
  const context = useContext(Context);
  if (!context) throw new Error('useUploads outside UploadsProvider');
  return context;
}
