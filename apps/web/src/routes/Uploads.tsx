import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  FilterBox,
  SortControl,
  useFileFilter,
  useFileSort,
} from '../components/ListControls.js';
import { Row } from '../components/UploadIndicator.js';
import { api } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';
import { useUploads } from '../lib/uploads.js';

interface Transfer {
  id: string;
  name: string;
  sizeBytes: number;
  transferredBytes: number;
  state: 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
  error: string | null;
  deleteSource: boolean;
}

/**
 * Background jobs: files going up, and files going between clouds.
 *
 * The header chip is for glancing at; this is for reading. It is where a
 * failure's reason can be seen in full rather than truncated into a row, and
 * those reasons are usually actionable - a folder no longer shared, an account
 * out of space, a transfer cut off by a restart.
 *
 * The two lists differ in one way worth knowing: an upload does not survive a
 * reload, because the queue holds handles to files on disk and a handle cannot
 * be restored from storage. A transfer does, because it lives on the server.
 */
export function Uploads() {
  const { jobs, active, failed, cancel, clearFinished } = useUploads();
  const [transfers, setTransfers] = useState<Transfer[]>([]);

  /**
   * Polled rather than pushed.
   *
   * A transfer publishes progress over the WebSocket, but only to the channel
   * for that one transfer - and this page wants the whole list, including ones
   * queued in another tab or left paused by a restart. Ten seconds is often
   * enough for a job measured in minutes.
   */
  useEffect(() => {
    let cancelled = false;

    const read = () =>
      api<{ transfers: Transfer[] }>('/api/transfers')
        .then(({ transfers: rows }) => {
          if (!cancelled) setTransfers(rows);
        })
        .catch(() => undefined);

    void read();
    const timer = setInterval(read, 10_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  async function act(id: string, action: 'resume' | 'cancel'): Promise<void> {
    await api(
      `/api/transfers/${id}${action === 'resume' ? '/resume' : ''}`,
      { method: action === 'resume' ? 'POST' : 'DELETE' },
    ).catch(() => undefined);

    const { transfers: rows } = await api<{ transfers: Transfer[] }>('/api/transfers');
    setTransfers(rows);
  }

  const finished = jobs.filter((job) => job.state !== 'uploading' && job.state !== 'queued');

  /*
   * The same filter and sort every other list of files has.
   *
   * `virtualPath` is the destination here rather than where a file lives, which
   * is the useful thing to search a queue by: "everything I sent to the R2
   * bucket" is a question people ask of this page and of no other.
   */
  const searchable = useMemo(
    () => jobs.map((job) => ({ ...job, virtualPath: `${job.destination}${job.targetPath}` })),
    [jobs],
  );

  const { filter, setFilter, shown } = useFileFilter(searchable);
  const { sort, setSort, descending, toggleDirection, sorted } = useFileSort('uploads', shown);

  /*
   * The same filter over the copies between clouds.
   *
   * They are on this page too, and a search box that quietly ignores half of
   * what is on screen is worse than none - somebody who filters and sees a
   * transfer still listed will conclude the filter is broken.
   */
  const shownTransfers = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return transfers;

    return transfers.filter((transfer) => transfer.name.toLowerCase().includes(needle));
  }, [transfers, filter]);

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'grid', gap: 4 }}>
            <h1 className="page-title">Uploads</h1>
            <p className="page-subtitle">
              {jobs.length === 0
                ? 'Nothing has been uploaded this session.'
                : `${active} in progress, ${finished.length - failed} finished, ${failed} failed.`}
            </p>
          </div>

          <span style={{ flex: 1 }} />

          {(jobs.length > 0 || transfers.length > 0) && (
            <SortControl
              sort={sort}
              onSort={setSort}
              descending={descending}
              onToggleDirection={toggleDirection}
            />
          )}

          {active > 0 && (
            <button type="button" className="clay-button" onClick={cancel}>
              Cancel remaining
            </button>
          )}
          {finished.length > 0 && (
            <button type="button" className="clay-button" onClick={clearFinished}>
              Clear finished
            </button>
          )}
        </div>

        <FilterBox
          value={filter}
          onChange={setFilter}
          count={jobs.length + transfers.length}
          noun="jobs"
        />
      </section>

      {shownTransfers.length > 0 && (
        <section className="clay" style={{ padding: '0.75rem' }}>
          <div className="collection-head">
            <strong>Between clouds</strong>
            <span>
              {transfers.filter((transfer) => transfer.state === 'running').length} running
            </span>
          </div>

          <ul className="upload-list">
            {shownTransfers.map((transfer) => {
              const percent =
                transfer.sizeBytes > 0
                  ? Math.round((transfer.transferredBytes / transfer.sizeBytes) * 100)
                  : 0;

              return (
                <li key={transfer.id}>
                  <div className="upload-row">
                    <div className="upload-row__top">
                      <span className="upload-row__name">{transfer.name}</span>
                      <span className="upload-row__size">{formatBytes(transfer.sizeBytes)}</span>
                    </div>

                    {transfer.state === 'running' && (
                      <div className="upload-row__track">
                        <div style={{ width: `${percent}%` }} />
                      </div>
                    )}

                    <span
                      className="upload-row__state"
                      data-state={transfer.state === 'failed' ? 'error' : transfer.state}
                    >
                      {transfer.error ??
                        (transfer.state === 'running'
                          ? `${percent}% · ${formatBytes(transfer.transferredBytes)} of ${formatBytes(transfer.sizeBytes)}`
                          : transfer.state === 'done'
                            ? transfer.deleteSource
                              ? 'Moved'
                              : 'Copied'
                            : transfer.state)}
                    </span>

                    <span className="upload-row__target">
                      {/* A paused transfer is resumable, which is the whole
                          point of recording the position - so say so. */}
                      {(transfer.state === 'paused' || transfer.state === 'failed') && (
                        <button
                          type="button"
                          className="clay-button"
                          onClick={() => void act(transfer.id, 'resume')}
                        >
                          Resume
                        </button>
                      )}
                      {(transfer.state === 'running' ||
                        transfer.state === 'queued' ||
                        transfer.state === 'paused') && (
                        <button
                          type="button"
                          className="clay-button"
                          onClick={() => void act(transfer.id, 'cancel')}
                        >
                          Cancel
                        </button>
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {jobs.length === 0 && transfers.length === 0 ? (
        <section className="clay" style={{ padding: 'clamp(1.5rem, 4vw, 2.5rem)', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>
            Uploads started from <Link to="/my-drive">My Drive</Link> appear here while they run, and
            stay listed afterwards so a failure can be read in full.
          </p>
        </section>
      ) : (
        <section className="clay" style={{ padding: '0.75rem' }}>
          <ul className="upload-list">
            {sorted.map((job) => (
              <li key={job.id}>
                <Row job={job} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
