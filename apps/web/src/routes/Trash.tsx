import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { catalogueEntry, type OrbitFile } from '@orbit/shared-types';
import { thumbnailAddress } from '../lib/thumbnails.js';
import { Checkbox } from '../components/Checkbox.js';
import { DragSelectBox, useDragSelect } from '../components/DragSelect.js';
import { FileIcon } from '../components/FileIcon.js';
import { FileGrid } from '../components/FileGrid.js';
import { FilePreview } from '../components/FilePreview.js';
import {
  FilterBox,
  SortControl,
  ViewToggle,
  useFileFilter,
  useFileSort,
  useListView,
} from '../components/ListControls.js';
import { ConfirmDialog } from '../components/NameDialog.js';
import { useBulk } from '../lib/bulk.js';
import { Pagination } from '../components/Pagination.js';
import { ProviderIcon } from '../components/ProviderIcon.js';
import { FileListSkeleton } from '../components/Skeleton.js';
import { StatusScreen, statusKindFor } from '../components/StatusScreen.js';
import { ApiError, api } from '../lib/api.js';
import { useRangeSelection } from '../lib/selection.js';
import { formatBytes } from '../lib/format.js';

/*
 * The bin has no ceiling either.
 *
 * It used to stop at whatever the first page happened to hold - two hundred
 * files - behind a "Load more" button. That is the same dead end My Drive had:
 * a bin is where somebody goes to find one file among everything they have
 * ever deleted, and a file past the cap could not be found by any means.
 *
 * Now it loads until every drive says there is nothing left, and pages over
 * the result. The count says how far it has got while that happens.
 */

/** Rows per page. Past this a single list is slow to render and worse to read. */
const PAGE_SIZE = 1000;

/**
 * What has been deleted but not yet destroyed.
 *
 * Worth a page because a deleted file is the one thing somebody comes back for
 * in a hurry, and until now finding one meant opening the provider's own site —
 * precisely the thing Orbit exists to stop being necessary.
 *
 * Providers disagree about what a bin is, and the page says so rather than
 * pretending they agree: Drive keeps one and will empty it, Dropbox holds
 * deleted files for thirty days and will restore one but only lets a business
 * plan destroy one early, and an object store has no bin at all.
 */

interface TrashedFile extends OrbitFile {
  accountId: string;
  accountNickname: string;
  provider: string;
  catalogueKey: string | null;
  canPurge: boolean;
  /** Null where the provider does not say when it was deleted. */
  purgesAt: string | null;
}

/**
 * How long is left, in the words somebody would use.
 *
 * The point of the page: whether to bother restoring something depends almost
 * entirely on this. Where the provider will not say, it says that instead of
 * showing a number it made up.
 */
function timeLeft(purgesAt: string | null): { text: string; urgent: boolean } {
  if (!purgesAt) return { text: 'Deadline unknown', urgent: false };

  const left = new Date(purgesAt).getTime() - Date.now();
  const days = Math.floor(left / 86_400_000);
  const hours = Math.floor((left % 86_400_000) / 3_600_000);

  if (left <= 0) return { text: 'Due to be destroyed', urgent: true };

  // Hours once it is down to the last day, because "0 days left" is not the
  // sentence somebody in a hurry needs.
  if (days === 0) return { text: `${Math.max(hours, 1)}h left`, urgent: true };
  if (days === 1) return { text: `1 day ${hours}h left`, urgent: true };
  if (days <= 7) return { text: `${days} days left`, urgent: true };

  return { text: `${days} days left`, urgent: false };
}

const API_BASE = import.meta.env.VITE_API_URL ?? '';

interface TrashResponse {
  files: TrashedFile[];
  noBin: Array<{ accountId: string; nickname: string }>;
  problems: Array<{ accountId: string; nickname: string; reason: string }>;
  nextCursor?: string;
}

export function Trash() {
  const [data, setData] = useState<TrashResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [purging, setPurging] = useState<TrashedFile | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [viewMode, setViewMode] = useListView('trash');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const bulk = useBulk();
  const [params, setParams] = useSearchParams();
  /*
   * From the queue, not from state held here, so walking off the page and
   * coming back shows the job still running rather than nothing at all. The
   * header carries it everywhere else.
   */
  const progress = bulk.active ? { done: bulk.active.done, total: bulk.active.total } : null;
  const [purgingMany, setPurgingMany] = useState(false);
  const [previewing, setPreviewing] = useState<TrashedFile | null>(null);

  /**
   * Drag a box over files to select them, as every file manager does.
   *
   * Disabled while a dialog is open: a drag behind a modal is a selection
   * nobody can see changing.
   */
  const { containerRef, box } = useDragSelect({
    enabled: !purging && !purgingMany && !previewing,
    onSelect: (keys, additive) =>
      setSelected((current) => (additive ? new Set([...current, ...keys]) : new Set(keys))),
    onClear: () => setSelected(new Set()),
  });

  const load = useCallback(async () => {
    try {
      setData(await api<TrashResponse>('/api/trash'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Could not open the bin'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A job now finishes wherever the reader happens to be, so the bin refreshes
  // itself rather than showing files that have already gone.
  useEffect(() => bulk.onFinished(() => void load()), [bulk, load]);

  /**
   * The rest of the bin, fetched behind the first page.
   *
   * The first page renders immediately and the remainder arrives after it, so
   * a large bin is usable straight away rather than either truncated or blank
   * until every drive has answered. It runs to the end: nothing is unreachable
   * and no page needs a button to get to.
   */
  useEffect(() => {
    if (!data?.nextCursor) return;

    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      setLoadingMore(true);
      let cursor: string | undefined = data.nextCursor;

      try {
        while (cursor && !cancelled) {
          const next: TrashResponse = await api<TrashResponse>(
            `/api/trash?cursor=${encodeURIComponent(cursor)}`,
            { signal: controller.signal },
          );

          if (cancelled) return;

          setData((current) =>
            current ? { ...next, files: [...current.files, ...next.files] } : next,
          );
          cursor = next.nextCursor;
        }
      } catch (err) {
        // A failed continuation leaves what already loaded in place; the count
        // still says more exists.
        if ((err as Error).name !== 'AbortError') setNotice('Could not load the rest of the bin.');
      } finally {
        if (!cancelled) setLoadingMore(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [data?.nextCursor]);

  const all = data?.files ?? [];
  const { filter, setFilter, shown: matching } = useFileFilter(all);
  const { sort, setSort, descending, toggleDirection, sorted } = useFileSort('trash', matching);

  const keyOf = (file: TrashedFile) => `${file.accountId}:${file.remoteId}`;

  // One page at a time reaches the DOM; the rest is held but not rendered.
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, Number(params.get('page')) || 1), pageCount);
  const paged =
    pageCount > 1
      ? sorted.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
      : sorted;

  function goToPage(next: number): void {
    const updated = new URLSearchParams(params);
    if (next <= 1) updated.delete('page');
    else updated.set('page', String(next));
    setParams(updated, { replace: false });
  }

  function toggle(key: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** The rows actually rendered, which is one page of what a filter left. */
  const shownKeys = paged.map(keyOf);
  const allShownSelected = shownKeys.length > 0 && shownKeys.every((key) => selected.has(key));

  /** Every row the filter left, across every page. */
  const everyKey = sorted.map(keyOf);
  const allSelected = everyKey.length > 0 && everyKey.every((key) => selected.has(key));

  function toggleAll(): void {
    // Selecting "all" while a filter is on must mean the rows in front of
    // somebody, not the ones the filter is hiding.
    setSelected((current) => {
      const next = new Set(current);
      if (allShownSelected) shownKeys.forEach((key) => next.delete(key));
      else shownKeys.forEach((key) => next.add(key));
      return next;
    });
  }

  /*
   * The same selection this app has everywhere else: ctrl to add one, shift for
   * the run between, arrows to walk, ctrl-A for the lot, escape to let go. It
   * matters more here than anywhere - the bin is where somebody picks out six
   * files from thirty and then presses a button that cannot be undone.
   */
  const listRef = useRef<HTMLDivElement>(null);
  const keyboard = useRangeSelection({
    keys: shownKeys,
    selected,
    setSelected,
    container: listRef,
  });

  /*
   * Every selected row, not every rendered one. Taking this from the page
   * would mean a restore announcing the full count and acting on a slice - the
   * same wrong-scope bug the file list had before select-all crossed pages.
   */
  const chosen = sorted.filter((file) => selected.has(keyOf(file)));
  /** A selection cannot be destroyed unless every file in it may be. */
  const canPurgeChosen = chosen.length > 0 && chosen.every((file) => file.canPurge);

  /**
   * Hands the selection to the queue above the router.
   *
   * The bin is where somebody empties thousands of files at once, and that is
   * minutes of work at the providers. Running it here meant navigating away
   * killed it; the queue batches, counts and reports from the header, so it
   * finishes wherever the reader ends up. Nothing to catch - a failure lands
   * on the job rather than throwing.
   */
  function actOnMany(kind: 'restore' | 'purge'): void {
    setNotice(null);
    setPurgingMany(false);

    bulk.run(
      kind,
      chosen.map((file) => ({ accountId: file.accountId, remoteId: file.remoteId })),
      `${chosen.length.toLocaleString()} ${chosen.length === 1 ? 'file' : 'files'}`,
    );

    setSelected(new Set());
  }

  function forget(file: TrashedFile): void {
    setData((current) =>
      current ? { ...current, files: current.files.filter((f) => keyOf(f) !== keyOf(file)) } : current,
    );
  }

  async function restore(file: TrashedFile): Promise<void> {
    setBusyId(keyOf(file));
    setNotice(null);

    try {
      await api('/api/trash/restore', {
        method: 'POST',
        body: { accountId: file.accountId, remoteId: file.remoteId },
      });
      forget(file);
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'Could not restore that file');
    } finally {
      setBusyId(null);
    }
  }

  async function purge(file: TrashedFile): Promise<void> {
    setBusyId(keyOf(file));
    setNotice(null);

    try {
      await api('/api/trash', {
        method: 'DELETE',
        body: { accountId: file.accountId, remoteId: file.remoteId },
      });
      setPurging(null);
      forget(file);
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'Could not destroy that file');
    } finally {
      setBusyId(null);
    }
  }


  if (error && data === null) {
    return (
      <StatusScreen
        kind={error instanceof ApiError ? statusKindFor(error.status) : 'server-error'}
        onRetry={() => void load()}
      />
    );
  }

  return (
    <div ref={containerRef} style={{ display: 'grid', gap: '1rem' }}>
      <DragSelectBox box={box} />

      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
            <h1 className="page-title">Bin</h1>
            <p className="page-subtitle">
              {data === null
                ? 'Looking through every drive that keeps a bin…'
                : all.length === 0
                  ? 'Nothing deleted is waiting to be recovered.'
                  : `${all.length.toLocaleString()} ${all.length === 1 ? 'file' : 'files'} deleted but not yet destroyed.`}
            </p>
          </div>

          <span style={{ flex: 1 }} />

          {selected.size > 0 && (
            <>
              <button type="button" className="clay-button" onClick={() => actOnMany('restore')}>
                Restore {selected.size}
              </button>
              <button
                type="button"
                className="clay-button"
                style={{ color: 'var(--danger)' }}
                // A selection cannot be destroyed unless every file in it may
                // be: a batch that silently skipped the ones it could not is
                // worse than one that refuses until the selection is honest.
                disabled={!canPurgeChosen}
                title={
                  canPurgeChosen
                    ? 'Destroy every selected file now'
                    : 'Some of these are on a drive that will not let this account empty its bin'
                }
                onClick={() => setPurgingMany(true)}
              >
                Delete {selected.size} for ever
              </button>
              <button type="button" className="clay-button" onClick={() => setSelected(new Set())}>
                Unselect
              </button>
            </>
          )}

          {all.length > 1 && (
            <SortControl
              sort={sort}
              onSort={setSort}
              descending={descending}
              onToggleDirection={toggleDirection}
            />
          )}

          <ViewToggle view={viewMode} onChange={setViewMode} />
        </div>

        <FilterBox value={filter} onChange={setFilter} count={all.length} />

        {/*
          * Both of these are worth saying and neither is worth two paragraphs
          * above the list. Folded away, they take one line; a reader who
          * wonders why a row has no countdown opens it and finds out.
          */}
        {data && (data.files.some((file) => file.purgesAt === null) || data.noBin.length > 0) && (
          <details className="fold">
            <summary>Why some files show no deadline</summary>

            {data.files.some((file) => file.purgesAt === null) && (
              <p>
                Providers mostly do not say when a file was deleted — Dropbox reports none at all,
                and Drive dates only the items in a shared drive — so Orbit counts from its own
                delete instead. Anything removed before this, or removed in the provider&rsquo;s own
                website, has no date to count from.
              </p>
            )}

            {data.noBin.length > 0 && (
              <p>
                {data.noBin.map((drive) => drive.nickname).join(', ')} keep no bin — a delete there
                is final and nothing from them can appear here.
              </p>
            )}
          </details>
        )}

        {data?.problems.map((problem) => (
          <p
            key={problem.accountId}
            style={{ color: 'var(--warning)', margin: '0.35rem 0 0', fontSize: 13 }}
          >
            {problem.nickname} {problem.reason}, so anything in its bin is missing here.
          </p>
        ))}
      </section>

      {notice && (
        <p role="alert" className="clay" style={{ padding: '0.8rem 1.1rem', margin: 0, color: 'var(--danger)' }}>
          {notice}
        </p>
      )}

      {/* The shape of what is coming, rather than the word "loading": a page
          that redraws into the same outline reads as fast even when it is not. */}
      {data === null && (
        <section className="clay" style={{ padding: '0.75rem' }}>
          <FileListSkeleton rows={6} />
        </section>
      )}

      {sorted.length > 0 && (
        <section
          className="clay"
          ref={listRef}
          style={{ padding: '0.75rem' }}
        >
          {/* The same control as every other tick in the app, rather than the
              browser's own - two kinds of checkbox on one page reads as one of
              them being broken. */}
          {/*
            * Above the selection it is describing, for the same reason as on
            * the file list: a count that only lives in a modal is a count
            * nobody can see beside the rows it is clearing.
            */}
          {progress && (
            <div className="delete-progress" role="status" aria-live="polite">
              <div className="delete-progress__label">
                <span>
                  Working through {progress.done.toLocaleString()} of{' '}
                  {progress.total.toLocaleString()}
                </span>
                <span>{Math.round((progress.done / progress.total) * 100)}%</span>
              </div>
              <div
                className="delete-progress__track"
                role="progressbar"
                aria-valuenow={progress.done}
                aria-valuemin={0}
                aria-valuemax={progress.total}
              >
                <div
                  className="delete-progress__fill"
                  style={{ width: `${(progress.done / progress.total) * 100}%` }}
                />
              </div>
            </div>
          )}

          <div className="trash-all">
            <Checkbox
              checked={allShownSelected}
              onChange={toggleAll}
              label={
                pageCount > 1
                  ? `Select page (${paged.length.toLocaleString()})`
                  : `${allShownSelected ? 'Unselect' : 'Select'} all ${sorted.length.toLocaleString()}${filter.trim() ? ' shown' : ''}`
              }
            />

            {/* Reaching past the page you can see is a different intention
                from ticking the list in front of you, so it gets its own
                control and its own count. */}
            {pageCount > 1 && (
              <button
                type="button"
                className="list-controls__all"
                onClick={() => setSelected(allSelected ? new Set() : new Set(everyKey))}
              >
                {allSelected
                  ? 'Clear selection'
                  : `Select all ${sorted.length.toLocaleString()}${filter.trim() ? ' shown' : ''}`}
              </button>
            )}
          </div>

          {viewMode === 'grid' && (
            <FileGrid
              files={paged}
              accountIdFor={(file) => (file as TrashedFile).accountId}
              selected={selected}
              // The bin spans drives, so a remote id alone does not identify a
              // file in it - the grid is told how this page keys them.
              selectionKey={(file) => keyOf(file as TrashedFile)}
              onToggleSelect={(remoteId) => {
                const match = sorted.find((file) => file.remoteId === remoteId);
                if (match) toggle(keyOf(match));
              }}
              onOpen={(file) => {
                const match = sorted.find((entry) => entry.remoteId === file.remoteId);
                if (match && !match.isFolder) setPreviewing(match);
              }}
              showLocation
              locationOf={(file) => {
                const entry = file as TrashedFile;
                const left = timeLeft(entry.purgesAt);

                return (
                  <>
                    <ProviderIcon provider={entry.catalogueKey ?? entry.provider} size={12} />
                    <span
                      style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}
                      title={`${catalogueEntry(entry.catalogueKey ?? '')?.label ?? entry.provider} · ${entry.accountNickname}`}
                    >
                      {entry.accountNickname}
                    </span>
                    {/* The deadline belongs on the tile too: it is the reason
                        somebody is on this page. */}
                    <span
                      className="trash-list__deadline"
                      data-urgent={left.urgent ? '' : undefined}
                      style={{ marginLeft: 'auto', flex: 'none' }}
                    >
                      {left.urgent ? left.text : ''}
                    </span>
                  </>
                );
              }}
            />
          )}

          {viewMode === 'list' && (
          <ul className="trash-list">
            {paged.map((file) => (
              <li
                key={keyOf(file)}
                data-file={keyOf(file)}
                data-selected={selected.has(keyOf(file)) ? '' : undefined}
                data-busy={busyId === keyOf(file) ? '' : undefined}
              >
                <Checkbox
                  checked={selected.has(keyOf(file))}
                  onChange={() => toggle(keyOf(file))}
                  aria-label={`Select ${file.name}`}
                  size={18}
                />

                <button
                  type="button"
                  className="dup-open"
                  title={file.isFolder ? 'A folder has nothing to preview' : 'Look at it before deciding'}
                  disabled={file.isFolder}
                  onClick={(event) => {
                    // A click holding shift or ctrl is a selection, not a look.
                    if (keyboard.activate(event, keyOf(file)) === 'selected') return;
                    setPreviewing(file);
                  }}
                >
                  <FileIcon
                    name={file.name}
                    mimeType={file.mimeType}
                    isFolder={file.isFolder}
                    size={22}
                  />
                </button>

                <span className="trash-list__what">
                  <strong>{file.name}</strong>
                  <span>
                    {file.isFolder ? 'Folder' : formatBytes(file.sizeBytes)} ·{' '}
                    <ProviderIcon provider={file.catalogueKey ?? file.provider} size={13} />{' '}
                    {catalogueEntry(file.catalogueKey ?? '')?.label ?? file.provider} ·{' '}
                    {file.accountNickname}
                    {' · '}
                    <span
                      className="trash-list__deadline"
                      data-urgent={timeLeft(file.purgesAt).urgent ? '' : undefined}
                    >
                      {timeLeft(file.purgesAt).text}
                    </span>
                  </span>
                </span>

                <span className="trash-list__actions">
                  <button
                    type="button"
                    className="clay-button"
                    title="Put it back where it was"
                    disabled={busyId === keyOf(file)}
                    onClick={() => void restore(file)}
                  >
                    Restore
                  </button>

                  <button
                    type="button"
                    className="clay-button"
                    style={{ color: 'var(--danger)' }}
                    // Disabled rather than hidden: absence reads as a bug,
                    // whereas a disabled button with a reason reads as a limit.
                    disabled={!file.canPurge || busyId === keyOf(file)}
                    title={
                      file.canPurge
                        ? 'Destroy it now, before the provider would have'
                        : 'This provider will not let this account empty its bin early'
                    }
                    onClick={() => setPurging(file)}
                  >
                    Delete for ever
                  </button>
                </span>
              </li>
            ))}
          </ul>
          )}

          <Pagination
            page={currentPage}
            pageCount={pageCount}
            totalItems={sorted.length}
            pageSize={PAGE_SIZE}
            onChange={goToPage}
          />

          {/* Says the list is still growing, rather than leaving a button to
              press for the rest of it. */}
          {loadingMore && (
            <p
              style={{ color: 'var(--text-muted)', fontSize: 13, padding: '0.75rem', margin: 0 }}
              aria-live="polite"
            >
              {sorted.length.toLocaleString()} so far, still looking through every drive…
            </p>
          )}
        </section>
      )}

      {all.length > 0 && sorted.length === 0 && (
        <section className="clay" style={{ padding: '1.25rem', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>Nothing here matches “{filter}”.</p>
        </section>
      )}

      {previewing && (
        <FilePreview
          file={previewing}
          // The bin is the set to step through: somebody looking for one thing
          // they lost is often looking at several.
          siblings={sorted.filter((file) => !file.isFolder)}
          contentUrl={(file, download) => {
            const owner =
              sorted.find((entry) => entry.remoteId === file.remoteId)?.accountId ??
              previewing.accountId;
            const query = new URLSearchParams({ accountId: owner });
            if (download) {
              query.set('download', '1');
              query.set('name', file.name);
            }
            return `${API_BASE}/api/files/${encodeURIComponent(file.remoteId)}/content?${query.toString()}`;
          }}
          thumbnailUrl={(file, size) =>
            thumbnailAddress(
              sorted.find((entry) => entry.remoteId === file.remoteId)?.accountId ??
                previewing.accountId,
              file.remoteId,
              size,
            )
          }
          onSelect={(next) => {
            const match = sorted.find((entry) => entry.remoteId === next.remoteId);
            if (match) setPreviewing(match);
          }}
          onClose={() => setPreviewing(null)}
        />
      )}

      {purgingMany && (
        <ConfirmDialog
          title={`Destroy ${chosen.length} ${chosen.length === 1 ? 'file' : 'files'}?`}
          description="This is the one thing in Orbit with nothing behind it. They leave the providers' bins immediately and cannot be recovered by anybody, including the providers."
          confirmLabel={`Destroy ${chosen.length}`}
          destructive
          onConfirm={() => actOnMany('purge')}
          onClose={() => setPurgingMany(false)}
        />
      )}

      {purging && (
        <ConfirmDialog
          title={`Destroy “${purging.name}”?`}
          description="This is the one thing in Orbit with nothing behind it. The file leaves the provider's bin immediately and cannot be recovered by anybody, including the provider."
          confirmLabel="Destroy it"
          destructive
          onConfirm={() => void purge(purging)}
          onClose={() => setPurging(null)}
        />
      )}
    </div>
  );
}
