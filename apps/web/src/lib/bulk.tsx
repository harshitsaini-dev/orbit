import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, api } from './api.js';

/**
 * Bulk deletes, restores and purges, held above the router.
 *
 * They used to run inside the page that started them, which meant navigating
 * to Quota half way through a delete unmounted the thing doing the deleting.
 * The progress bar vanished, and the work went with it. Exactly the mistake
 * the upload queue had made, and fixed, for exactly the same reason: this is a
 * background job, and a background job has to survive going to look at
 * something else.
 *
 * Batching is the whole shape of it. A selection can be fifty thousand files,
 * the routes take a few hundred per request, and the API is behind a proxy
 * that closes a request after a hundred seconds. So the work is cut into
 * batches, sent one after another, and counted as it goes.
 */

export type BulkKind = 'delete' | 'restore' | 'purge';

/** One file, addressed the way every one of these routes addresses one. */
export interface BulkTarget {
  accountId: string;
  remoteId: string;
}

export interface BulkJob {
  id: string;
  kind: BulkKind;
  /** What to call it on screen, e.g. "1,200 files". */
  label: string;
  total: number;
  done: number;
  failed: number;
  state: 'running' | 'done' | 'error';
  /** Set when the whole job stopped, as opposed to individual files failing. */
  error?: string;
  /**
   * The first reason a file was refused.
   *
   * One example beats a count: "43 could not be deleted" sends somebody
   * looking, where "43 could not be deleted - insufficient permissions" is
   * usually the whole answer.
   */
  reason?: string;
}

interface BulkContext {
  jobs: BulkJob[];
  /** Starts one, and returns its id. Never throws; failures land on the job. */
  run: (kind: BulkKind, targets: BulkTarget[], label: string) => string;
  clearFinished: () => void;
  /** Fires when a job finishes, so an open page can refresh itself. */
  onFinished: (listener: () => void) => () => void;
  /** The job still running, if any. There is only ever one. */
  active: BulkJob | null;
}

const Context = createContext<BulkContext | null>(null);

/*
 * Files per request.
 *
 * Under every route's own cap - 500 for a delete, 200 for the bin - and well
 * under on purpose. Each batch is a run of provider calls held open by one
 * request, and fifty of those is a few seconds: far enough from the proxy's
 * hundred-second ceiling that a slow provider, or a rate limit being waited
 * out, still lands inside it.
 *
 * Small batches also mean the progress bar moves, which is the difference
 * between a long job and an apparently frozen one.
 */
const BATCH = 50;

const ROUTES: Record<BulkKind, { path: string; method: 'DELETE' | 'POST' }> = {
  delete: { path: '/api/files', method: 'DELETE' },
  restore: { path: '/api/trash/restore-many', method: 'POST' },
  purge: { path: '/api/trash/purge-many', method: 'POST' },
};

let counter = 0;
const nextId = () => `bulk-${(counter += 1)}`;

/** The two body shapes these routes take, which differ for historical reasons. */
function bodyFor(kind: BulkKind, batch: BulkTarget[]): Record<string, unknown> {
  if (kind !== 'delete') return { files: batch };

  // The delete route is scoped to one account and takes bare ids.
  return { accountId: batch[0]!.accountId, remoteIds: batch.map((entry) => entry.remoteId) };
}

/**
 * A delete is one account at a time; the bin spans drives.
 *
 * Grouping keeps each request valid without the caller having to know which
 * route cares. A selection from one folder is one group anyway.
 */
function batchesOf(kind: BulkKind, targets: BulkTarget[]): BulkTarget[][] {
  const groups =
    kind === 'delete'
      ? [...targets.reduce((map, entry) => {
          map.set(entry.accountId, [...(map.get(entry.accountId) ?? []), entry]);
          return map;
        }, new Map<string, BulkTarget[]>()).values()]
      : [targets];

  const batches: BulkTarget[][] = [];
  for (const group of groups) {
    for (let start = 0; start < group.length; start += BATCH) {
      batches.push(group.slice(start, start + BATCH));
    }
  }
  return batches;
}

export function BulkProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<BulkJob[]>([]);
  const listeners = useRef(new Set<() => void>());

  const update = useCallback((id: string, changes: Partial<BulkJob>) => {
    setJobs((current) => current.map((job) => (job.id === id ? { ...job, ...changes } : job)));
  }, []);

  const run = useCallback<BulkContext['run']>(
    (kind, targets, label) => {
      const id = nextId();

      setJobs((current) => [
        ...current,
        { id, kind, label, total: targets.length, done: 0, failed: 0, state: 'running' },
      ]);

      void (async () => {
        let done = 0;
        let failed = 0;
        let reason: string | undefined;

        try {
          for (const batch of batchesOf(kind, targets)) {
            const outcome = await api<{ failed?: Array<{ reason: string }> }>(ROUTES[kind].path, {
              method: ROUTES[kind].method,
              body: bodyFor(kind, batch),
            });

            done += batch.length;
            failed += outcome.failed?.length ?? 0;
            reason ??= outcome.failed?.[0]?.reason;

            update(id, { done, failed, ...(reason ? { reason } : {}) });
          }

          update(id, { state: 'done', done, failed, ...(reason ? { reason } : {}) });
        } catch (err) {
          /*
           * A batch failing outright leaves the earlier ones applied. The count
           * stays on the job, because "nothing happened" and "the first eight
           * hundred happened" call for different next steps.
           */
          update(id, {
            state: 'error',
            done,
            failed,
            error: err instanceof ApiError ? err.message : 'That did not work',
          });
        } finally {
          for (const listener of listeners.current) listener();
        }
      })();

      return id;
    },
    [update],
  );

  const value = useMemo<BulkContext>(
    () => ({
      jobs,
      run,
      clearFinished: () => setJobs((current) => current.filter((job) => job.state === 'running')),
      onFinished: (listener) => {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
      active: jobs.find((job) => job.state === 'running') ?? null,
    }),
    [jobs, run],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useBulk(): BulkContext {
  const value = useContext(Context);
  if (!value) throw new Error('useBulk needs a BulkProvider above it');
  return value;
}

/** What to call the job while it runs, and after. */
export function bulkVerb(kind: BulkKind, finished: boolean): string {
  if (kind === 'restore') return finished ? 'Restored' : 'Restoring';
  if (kind === 'purge') return finished ? 'Destroyed' : 'Destroying';
  return finished ? 'Deleted' : 'Deleting';
}
