import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { OrbitFile, WorkspaceView as ViewName } from '@orbit/shared-types';
import { DownloadIcon, StarIcon } from '../components/ActionIcon.js';
import { FileIcon } from '../components/FileIcon.js';
import { FilePreview } from '../components/FilePreview.js';
import { ProviderIcon } from '../components/ProviderIcon.js';
import { api, ApiError } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

interface WorkspaceFile extends OrbitFile {
  accountId: string;
  provider: string;
  accountNickname: string;
}

interface ViewResponse {
  files: WorkspaceFile[];
  problems: Array<{ accountId: string; nickname: string; reason: string }>;
  unsupported: Array<{ accountId: string; nickname: string }>;
}

const COPY: Record<ViewName, { title: string; blurb: string; empty: string }> = {
  recent: {
    title: 'Recent',
    blurb: 'What changed most recently, across every connected account.',
    empty: 'Nothing has changed recently.',
  },
  starred: {
    title: 'Starred',
    blurb: 'Everything you have starred, from all your accounts at once.',
    empty: 'Nothing is starred yet.',
  },
  shared: {
    title: 'Shared with me',
    blurb: 'Files other people have shared with your connected accounts.',
    empty: 'Nobody has shared anything with you.',
  },
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.getFullYear() < 1980) return '—';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Recent, starred and shared-with-me. All three are the same list of one
 * merged query, so they share a component — the only differences are the words
 * and which endpoint answers.
 */
export function WorkspaceViewPage({ view }: { view: ViewName }) {
  const [data, setData] = useState<ViewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<WorkspaceFile | null>(null);

  const copy = COPY[view];

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api<ViewResponse>(`/api/views/${view}`));
    } catch (err) {
      setData(null);
      setError(err instanceof ApiError ? err.message : 'Could not load this view');
    } finally {
      setLoading(false);
    }
  }, [view]);

  useEffect(() => {
    setPreviewing(null);
    void load();
  }, [load]);

  function contentUrl(file: OrbitFile, download: boolean): string {
    const source = (file as WorkspaceFile).accountId;
    const query = new URLSearchParams({ accountId: source });
    if (download) {
      query.set('download', '1');
      query.set('name', file.name);
    }
    return `${API_BASE}/api/files/${encodeURIComponent(file.remoteId)}/content?${query.toString()}`;
  }

  async function toggleStar(file: WorkspaceFile) {
    setBusyId(file.remoteId);
    try {
      await api(`/api/files/${encodeURIComponent(file.remoteId)}`, {
        method: 'PATCH',
        body: { accountId: file.accountId, starred: !file.starred },
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update');
    } finally {
      setBusyId(null);
    }
  }

  const files = data?.files ?? [];
  // Only worth naming the source when more than one account contributed.
  const multipleAccounts = new Set(files.map((file) => file.accountId)).size > 1;

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)', display: 'grid', gap: '0.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: '1.4rem' }}>{copy.title}</h1>
          <button
            type="button"
            className="clay-button"
            style={{ padding: '0.4rem 1rem', fontSize: 13 }}
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        <p style={{ color: 'var(--text-muted)', margin: 0 }}>{copy.blurb}</p>

        {error && (
          <p role="alert" style={{ color: 'var(--danger)', margin: '0.5rem 0 0', fontSize: 14 }}>
            {error}
          </p>
        )}

        {/* A partial result must never look complete. */}
        {data?.problems.map((problem) => (
          <p key={problem.accountId} style={{ color: 'var(--warning)', margin: '0.25rem 0 0', fontSize: 13 }}>
            {problem.nickname} {problem.reason}, so its files are missing here.{' '}
            <Link to="/quota" style={{ color: 'var(--accent)' }}>
              Open accounts
            </Link>
          </p>
        ))}

        {data && data.unsupported.length > 0 && (
          <p style={{ color: 'var(--text-muted)', margin: '0.25rem 0 0', fontSize: 13 }}>
            {data.unsupported.map((entry) => entry.nickname).join(', ')} cannot offer this view.
          </p>
        )}
      </section>

      <section className="clay" style={{ padding: 'clamp(0.75rem, 2vw, 1.25rem)' }}>
        {loading && !data && <p style={{ color: 'var(--text-muted)', padding: '1rem' }}>Loading…</p>}

        {data && files.length === 0 && (
          <p style={{ color: 'var(--text-muted)', padding: '1rem' }}>{copy.empty}</p>
        )}

        {files.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 4 }} data-testid="view-list">
            {files.map((file) => (
              <li
                key={`${file.accountId}:${file.remoteId}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '0.55rem 0.6rem',
                  borderRadius: 'var(--radius-sm)',
                  opacity: busyId === file.remoteId ? 0.5 : 1,
                  minWidth: 0,
                }}
              >
                <FileIcon name={file.name} mimeType={file.mimeType} isFolder={file.isFolder} />

                <button
                  type="button"
                  onClick={() => setPreviewing(file)}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    textAlign: 'left',
                    background: 'none',
                    border: 0,
                    font: 'inherit',
                    color: 'inherit',
                    cursor: 'pointer',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    padding: 0,
                  }}
                >
                  {file.name}
                </button>

                {multipleAccounts && (
                  <span
                    title={file.accountNickname}
                    style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}
                  >
                    <ProviderIcon provider={file.provider} size={16} />
                    <span
                      className="file-row__date"
                      style={{ color: 'var(--text-muted)', fontSize: 12, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {file.accountNickname}
                    </span>
                  </span>
                )}

                {!file.isFolder && file.sizeBytes > 0 && (
                  <span style={{ color: 'var(--text-muted)', fontSize: 12, whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {formatBytes(file.sizeBytes)}
                  </span>
                )}

                <span
                  className="file-row__date"
                  style={{ color: 'var(--text-muted)', fontSize: 12, width: 96, textAlign: 'right', flexShrink: 0 }}
                >
                  {formatDate(file.modifiedAt)}
                </span>

                <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <button
                    type="button"
                    className="clay-button"
                    aria-label={file.starred ? `Unstar ${file.name}` : `Star ${file.name}`}
                    disabled={busyId !== null}
                    onClick={() => void toggleStar(file)}
                    style={{
                      padding: '0.35rem',
                      display: 'grid',
                      placeItems: 'center',
                      color: file.starred ? 'var(--warning)' : 'var(--text-muted)',
                    }}
                  >
                    <StarIcon filled={file.starred} />
                  </button>

                  {!file.isFolder && (
                    <a
                      className="clay-button"
                      href={contentUrl(file, true)}
                      aria-label={`Download ${file.name}`}
                      style={{ padding: '0.35rem', display: 'grid', placeItems: 'center', textDecoration: 'none', color: 'var(--text-muted)' }}
                    >
                      <DownloadIcon />
                    </a>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {previewing && (
        <FilePreview
          file={previewing}
          siblings={files}
          contentUrl={contentUrl}
          onSelect={(file) => setPreviewing(file as WorkspaceFile)}
          onClose={() => setPreviewing(null)}
        />
      )}
    </div>
  );
}
