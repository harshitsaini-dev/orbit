import { useCallback, useEffect, useState } from 'react';
import { catalogueEntry, type OrbitFile } from '@orbit/shared-types';
import { FileIcon } from '../components/FileIcon.js';
import { FilterBox, SortControl, useFileFilter, useFileSort } from '../components/ListControls.js';
import { ConfirmDialog } from '../components/NameDialog.js';
import { ProviderIcon } from '../components/ProviderIcon.js';
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
}

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
                ? 'Looking…'
                : all.length === 0
                  ? 'Nothing deleted is waiting to be recovered.'
                  : `${all.length} ${all.length === 1 ? 'file' : 'files'} deleted but not yet destroyed.`}
            </p>
          </div>

          <span style={{ flex: 1 }} />

          {all.length > 1 && (
            <SortControl
              sort={sort}
              onSort={setSort}
              descending={descending}
              onToggleDirection={toggleDirection}
            />
          )}
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

      {sorted.length > 0 && (
        <section className="clay" style={{ padding: '0.75rem' }}>
          <ul className="trash-list">
            {sorted.map((file) => (
              <li key={keyOf(file)} data-busy={busyId === keyOf(file) ? '' : undefined}>
                <FileIcon
                  name={file.name}
                  mimeType={file.mimeType}
                  isFolder={file.isFolder}
                  size={22}
                />

                <span className="trash-list__what">
                  <strong>{file.name}</strong>
                  <span>
                    {file.isFolder ? 'Folder' : formatBytes(file.sizeBytes)} ·{' '}
                    <ProviderIcon provider={file.catalogueKey ?? file.provider} size={13} />{' '}
                    {catalogueEntry(file.catalogueKey ?? '')?.label ?? file.provider} ·{' '}
                    {file.accountNickname}
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
