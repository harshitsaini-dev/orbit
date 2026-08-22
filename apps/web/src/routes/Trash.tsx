import { useCallback, useEffect, useState } from 'react';
import { catalogueEntry, type OrbitFile } from '@orbit/shared-types';
import { Checkbox } from '../components/Checkbox.js';
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
import { ProviderIcon } from '../components/ProviderIcon.js';
import { FileListSkeleton } from '../components/Skeleton.js';
import { StatusScreen, statusKindFor } from '../components/StatusScreen.js';
import { ApiError, api } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';

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
  if (!purgesAt) return { text: 'No deadline reported', urgent: false };

  const days = Math.ceil((new Date(purgesAt).getTime() - Date.now()) / 86_400_000);

  if (days <= 0) return { text: 'Due to be destroyed', urgent: true };
  if (days === 1) return { text: '1 day left', urgent: true };
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
  const [purgingMany, setPurgingMany] = useState(false);
  const [previewing, setPreviewing] = useState<TrashedFile | null>(null);

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

  const all = data?.files ?? [];
  const { filter, setFilter, shown: matching } = useFileFilter(all);
  const { sort, setSort, descending, toggleDirection, sorted } = useFileSort('trash', matching);

  const keyOf = (file: TrashedFile) => `${file.accountId}:${file.remoteId}`;

  function toggle(key: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** Everything currently shown, which is not the same as everything there is. */
  const shownKeys = sorted.map(keyOf);
  const allShownSelected = shownKeys.length > 0 && shownKeys.every((key) => selected.has(key));

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

  const chosen = sorted.filter((file) => selected.has(keyOf(file)));
  /** A selection cannot be destroyed unless every file in it may be. */
  const canPurgeChosen = chosen.length > 0 && chosen.every((file) => file.canPurge);

  async function actOnMany(kind: 'restore' | 'purge'): Promise<void> {
    setNotice(null);
    setPurgingMany(false);

    const files = chosen.map((file) => ({ accountId: file.accountId, remoteId: file.remoteId }));

    try {
      const outcome = await api<{ failed: Array<{ reason: string }>; succeeded: unknown[] }>(
        kind === 'restore' ? '/api/trash/restore-many' : '/api/trash/purge-many',
        { method: 'POST', body: { files } },
      );

      setSelected(new Set());
      await load();

      // A mixed batch says so. Reporting "done" for a selection where two
      // failed is how somebody discovers it a week later.
      if (outcome.failed.length > 0) {
        setNotice(
          `${outcome.succeeded.length} done, ${outcome.failed.length} could not be: ${outcome.failed[0]!.reason}`,
        );
      }
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'That did not work');
    }
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

  async function loadMore(): Promise<void> {
    if (!data?.nextCursor || loadingMore) return;
    setLoadingMore(true);

    try {
      const next = await api<TrashResponse>(
        `/api/trash?cursor=${encodeURIComponent(data.nextCursor)}`,
      );
      setData((current) =>
        current ? { ...next, files: [...current.files, ...next.files] } : next,
      );
    } catch {
      setNotice('Could not load any more');
    } finally {
      setLoadingMore(false);
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
    <div style={{ display: 'grid', gap: '1rem' }}>
      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
            <h1 style={{ fontSize: '1.4rem', margin: 0 }}>Bin</h1>
            <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: 14 }}>
              {data === null
                ? 'Looking through every drive that keeps a bin…'
                : all.length === 0
                  ? 'Nothing deleted is waiting to be recovered.'
                  : `${all.length} ${all.length === 1 ? 'file' : 'files'} deleted but not yet destroyed.`}
            </p>
          </div>

          <span style={{ flex: 1 }} />

          {selected.size > 0 && (
            <>
              <button type="button" className="clay-button" onClick={() => void actOnMany('restore')}>
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

        {/* Said plainly rather than left to be discovered by a delete that
            cannot be undone. */}
        {data && data.noBin.length > 0 && (
          <p className="share-hint" style={{ marginTop: '0.7rem' }}>
            {data.noBin.map((drive) => drive.nickname).join(', ')} keep no bin — a delete there is
            final and nothing from them can appear here.
          </p>
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
        <section className="clay" style={{ padding: '0.75rem' }}>
          {/* The same control as every other tick in the app, rather than the
              browser's own - two kinds of checkbox on one page reads as one of
              them being broken. */}
          <div className="trash-all">
            <Checkbox
              checked={allShownSelected}
              onChange={toggleAll}
              label={`${allShownSelected ? 'Unselect' : 'Select'} all ${sorted.length}${filter.trim() ? ' shown' : ''}`}
            />
          </div>

          {viewMode === 'grid' && (
            <FileGrid
              files={sorted}
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
            {sorted.map((file) => (
              <li key={keyOf(file)} data-busy={busyId === keyOf(file) ? '' : undefined}>
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
                  onClick={() => setPreviewing(file)}
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

          {data?.nextCursor && (
            <div style={{ display: 'grid', placeItems: 'center', padding: '0.9rem 0 0.3rem' }}>
              <button
                type="button"
                className="clay-button"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
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
          onConfirm={() => void actOnMany('purge')}
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
