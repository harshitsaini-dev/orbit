import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { OrbitFile, ProviderCapabilities, PublicAccount } from '@orbit/shared-types';
import { DownloadIcon, RenameIcon, StarIcon } from '../components/ActionIcon.js';
import { FileIcon } from '../components/FileIcon.js';
import { ProviderIcon } from '../components/ProviderIcon.js';
import { api, ApiError } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

interface Listing {
  accountId: string;
  provider: string;
  path: string;
  files: OrbitFile[];
  nextCursor?: string;
  capabilities: ProviderCapabilities;
}

function parentOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return `/${parts.join('/')}`.replace(/\/+$/, '') || '/';
}

function crumbsFor(path: string): Array<{ label: string; path: string }> {
  const parts = path.split('/').filter(Boolean);
  const crumbs = [{ label: 'Home', path: '/' }];

  let running = '';
  for (const part of parts) {
    running += `/${part}`;
    crumbs.push({ label: part, path: running });
  }
  return crumbs;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.getFullYear() < 1980) return '—';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function MyDrive() {
  const [params, setParams] = useSearchParams();
  const [accounts, setAccounts] = useState<PublicAccount[] | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const accountId = params.get('account') ?? '';
  const path = params.get('path') ?? '/';

  function navigate(next: { account?: string; path?: string }): void {
    const updated = new URLSearchParams(params);
    if (next.account !== undefined) updated.set('account', next.account);
    if (next.path !== undefined) updated.set('path', next.path);
    setParams(updated, { replace: false });
    setSelected(new Set());
  }

  useEffect(() => {
    api<{ accounts: PublicAccount[] }>('/api/accounts')
      .then(({ accounts: rows }) => {
        setAccounts(rows);
        // Land on the first account rather than making the user pick one.
        if (!accountId && rows[0]) navigate({ account: rows[0].id, path: '/' });
      })
      .catch(() => setError('Could not load accounts'));
    // Deliberately once: this only seeds the initial selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    if (!accountId) return;

    setLoading(true);
    setError(null);
    try {
      const result = await api<Listing>(
        `/api/files?accountId=${encodeURIComponent(accountId)}&path=${encodeURIComponent(path)}`,
      );
      setListing(result);
    } catch (err) {
      setListing(null);
      setError(
        err instanceof ApiError
          ? err.code === 'needs_reauth'
            ? 'This account needs reconnecting. Open Quota to reconnect it.'
            : err.message
          : 'Could not list this folder',
      );
    } finally {
      setLoading(false);
    }
  }, [accountId, path]);

  useEffect(() => {
    void load();
  }, [load]);

  const capabilities = listing?.capabilities;

  function contentUrl(file: OrbitFile, download: boolean): string {
    const query = new URLSearchParams({ accountId });
    if (download) {
      query.set('download', '1');
      query.set('name', file.name);
    }
    return `${API_BASE}/api/files/${encodeURIComponent(file.remoteId)}/content?${query.toString()}`;
  }

  async function createFolder() {
    const name = window.prompt('New folder name');
    if (!name?.trim()) return;

    setBusyId('new-folder');
    try {
      await api('/api/files/folder', { method: 'POST', body: { accountId, path, name: name.trim() } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the folder');
    } finally {
      setBusyId(null);
    }
  }

  async function rename(file: OrbitFile) {
    const name = window.prompt('New name', file.name);
    if (!name?.trim() || name === file.name) return;

    setBusyId(file.remoteId);
    try {
      await api(`/api/files/${encodeURIComponent(file.remoteId)}`, {
        method: 'PATCH',
        body: { accountId, name: name.trim() },
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not rename');
    } finally {
      setBusyId(null);
    }
  }

  async function toggleStar(file: OrbitFile) {
    setBusyId(file.remoteId);
    try {
      await api(`/api/files/${encodeURIComponent(file.remoteId)}`, {
        method: 'PATCH',
        body: { accountId, starred: !file.starred },
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(files: OrbitFile[]) {
    const what = files.length === 1 ? `"${files[0]!.name}"` : `${files.length} items`;
    if (!window.confirm(`Move ${what} to the provider's trash?`)) return;

    setBusyId('delete');
    try {
      const result = await api<{ succeeded: string[]; failed: Array<{ remoteId: string; reason: string }> }>(
        '/api/files',
        { method: 'DELETE', body: { accountId, remoteIds: files.map((f) => f.remoteId) } },
      );
      if (result.failed.length > 0) {
        setError(`${result.failed.length} of ${files.length} could not be deleted.`);
      }
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete');
    } finally {
      setBusyId(null);
    }
  }

  function toggleSelected(remoteId: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(remoteId)) next.delete(remoteId);
      else next.add(remoteId);
      return next;
    });
  }

  const selectedFiles = (listing?.files ?? []).filter((file) => selected.has(file.remoteId));

  if (accounts?.length === 0) {
    return (
      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
        <h1 style={{ fontSize: '1.4rem' }}>My Drive</h1>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem' }}>
          No accounts connected yet. Open Quota to connect one.
        </p>
      </section>
    );
  }

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <section className="clay" style={{ padding: 'clamp(1rem, 3vw, 1.5rem)', display: 'grid', gap: '0.9rem' }}>
        {accounts && accounts.length > 1 && (
          <div className="scroll-x" style={{ display: 'flex', gap: 8, paddingBottom: 4 }}>
            {accounts.map((account) => (
              <button
                key={account.id}
                type="button"
                className="clay-button"
                aria-pressed={account.id === accountId}
                onClick={() => navigate({ account: account.id, path: '/' })}
                style={{
                  padding: '0.4rem 0.9rem',
                  fontSize: 13,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  whiteSpace: 'nowrap',
                  boxShadow: account.id === accountId ? 'var(--shadow-clay-inset)' : 'var(--shadow-clay)',
                }}
              >
                <ProviderIcon provider={account.provider} size={18} />
                {account.nickname}
              </button>
            ))}
          </div>
        )}

        <nav aria-label="Folder path" className="scroll-x">
          <ol
            style={{
              listStyle: 'none',
              display: 'flex',
              gap: 4,
              padding: 0,
              margin: 0,
              alignItems: 'center',
              whiteSpace: 'nowrap',
            }}
          >
            {crumbsFor(path).map((crumb, index, all) => (
              <li key={crumb.path} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {index > 0 && <span style={{ color: 'var(--text-muted)' }}>/</span>}
                {index === all.length - 1 ? (
                  <span style={{ fontWeight: 600 }}>{crumb.label}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => navigate({ path: crumb.path })}
                    style={{
                      background: 'none',
                      border: 0,
                      padding: '0.2rem 0.3rem',
                      color: 'var(--accent)',
                      cursor: 'pointer',
                      font: 'inherit',
                    }}
                  >
                    {crumb.label}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </nav>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {path !== '/' && (
            <button
              type="button"
              className="clay-button"
              style={{ padding: '0.4rem 1rem', fontSize: 13 }}
              onClick={() => navigate({ path: parentOf(path) })}
            >
              Up
            </button>
          )}
          <button
            type="button"
            className="clay-button"
            style={{ padding: '0.4rem 1rem', fontSize: 13 }}
            disabled={busyId !== null}
            onClick={() => void createFolder()}
          >
            New folder
          </button>
          <button
            type="button"
            className="clay-button"
            style={{ padding: '0.4rem 1rem', fontSize: 13 }}
            disabled={loading}
            onClick={() => void load()}
          >
            Refresh
          </button>

          {selectedFiles.length > 0 && (
            <button
              type="button"
              className="clay-button"
              style={{ padding: '0.4rem 1rem', fontSize: 13, color: 'var(--danger)' }}
              disabled={busyId !== null}
              onClick={() => void remove(selectedFiles)}
            >
              Delete {selectedFiles.length}
            </button>
          )}
        </div>

        {error && (
          <p role="alert" style={{ color: 'var(--danger)', margin: 0, fontSize: 14 }}>
            {error}
          </p>
        )}
      </section>

      <section className="clay" style={{ padding: 'clamp(0.75rem, 2vw, 1.25rem)' }}>
        {loading && !listing && <p style={{ color: 'var(--text-muted)' }}>Loading…</p>}

        {listing?.files.length === 0 && (
          <p style={{ color: 'var(--text-muted)', padding: '1rem' }}>This folder is empty.</p>
        )}

        {listing && listing.files.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 4 }} data-testid="file-list">
            {listing.files.map((file) => (
              <li
                key={file.remoteId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '0.55rem 0.6rem',
                  borderRadius: 'var(--radius-sm)',
                  background: selected.has(file.remoteId) ? 'var(--accent-soft)' : 'transparent',
                  opacity: busyId === file.remoteId ? 0.5 : 1,
                  minWidth: 0,
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(file.remoteId)}
                  onChange={() => toggleSelected(file.remoteId)}
                  aria-label={`Select ${file.name}`}
                  style={{ width: 18, height: 18, flexShrink: 0, accentColor: 'var(--accent)' }}
                />

                <FileIcon name={file.name} mimeType={file.mimeType} isFolder={file.isFolder} />

                {file.isFolder ? (
                  <button
                    type="button"
                    onClick={() => navigate({ path: file.virtualPath })}
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
                ) : (
                  <a
                    href={contentUrl(file, false)}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      flex: 1,
                      minWidth: 0,
                      color: 'inherit',
                      textDecoration: 'none',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {file.name}
                  </a>
                )}

                {!file.isFolder && (
                  <span
                    style={{
                      color: 'var(--text-muted)',
                      fontSize: 12,
                      textAlign: 'right',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                  >
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
                  {capabilities?.star && (
                    <button
                      type="button"
                      className="clay-button"
                      title={file.starred ? 'Unstar' : 'Star'}
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
                  )}

                  {!file.isFolder && (
                    <a
                      className="clay-button"
                      href={contentUrl(file, true)}
                      title="Download"
                      aria-label={`Download ${file.name}`}
                      style={{
                        padding: '0.35rem',
                        display: 'grid',
                        placeItems: 'center',
                        textDecoration: 'none',
                        color: 'var(--text-muted)',
                      }}
                    >
                      <DownloadIcon />
                    </a>
                  )}

                  <button
                    type="button"
                    className="clay-button"
                    title="Rename"
                    aria-label={`Rename ${file.name}`}
                    disabled={busyId !== null}
                    onClick={() => void rename(file)}
                    style={{ padding: '0.35rem', display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}
                  >
                    <RenameIcon />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        {listing?.nextCursor && (
          <p style={{ color: 'var(--text-muted)', fontSize: 13, padding: '0.75rem' }}>
            Showing the first {listing.files.length} items. Paging arrives with the sync engine in
            Phase 6.
          </p>
        )}
      </section>
    </div>
  );
}
