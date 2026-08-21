import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { OrbitFile, ProviderCapabilities, PublicAccount } from '@orbit/shared-types';
import { DownloadIcon, RenameIcon, StarIcon } from '../components/ActionIcon.js';
import { FileIcon } from '../components/FileIcon.js';
import { FilePreview } from '../components/FilePreview.js';
import { Checkbox } from '../components/Checkbox.js';
import { ConfirmDialog, NameDialog } from '../components/NameDialog.js';
import { Select } from '../components/Select.js';
import { UploadPanel, forgetFiles, registerFile } from '../components/UploadPanel.js';
import {
  EMPTY_FILTERS,
  SIZE_BANDS,
  SearchBar,
  hasCriteria,
  type SearchFilters,
} from '../components/SearchBar.js';
import { filesFromDataTransfer, type UploadItem } from '../lib/upload.js';
import { ProviderIcon } from '../components/ProviderIcon.js';
import { api, ApiError } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

interface WorkspaceSearchFile extends OrbitFile {
  accountId: string;
  provider: string;
  accountNickname: string;
}

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

/** The folder a search result lives in, for the second line under its name. */
function locationOf(file: OrbitFile): string {
  const parts = file.virtualPath.split('/').filter(Boolean);
  parts.pop();
  return parts.length === 0 ? 'This drive' : `/${parts.join('/')}`;
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
  const [previewing, setPreviewing] = useState<OrbitFile | null>(null);

  // Dialogs replace window.prompt and window.confirm, which the browser draws
  // itself, ignore the theme, and on some platforms suppress outright.
  const [dialog, setDialog] = useState<
    | { kind: 'new-folder' }
    | { kind: 'rename'; file: OrbitFile }
    | { kind: 'delete'; files: OrbitFile[] }
    | null
  >(null);

  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const [filters, setFilters] = useState<SearchFilters>(EMPTY_FILTERS);
  const [results, setResults] = useState<WorkspaceSearchFile[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [sort, setSort] = useState<'name' | 'size' | 'modified'>('name');

  const accountId = params.get('account') ?? '';
  const path = params.get('path') ?? '/';

  function navigate(next: { account?: string; path?: string }): void {
    const updated = new URLSearchParams(params);
    if (next.account !== undefined) updated.set('account', next.account);
    if (next.path !== undefined) updated.set('path', next.path);
    setParams(updated, { replace: false });
    setSelected(new Set());
    setPreviewing(null);
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
  const searchActive = hasCriteria(filters);

  /**
   * Runs against the provider rather than over the loaded page, so it reaches
   * into subfolders the way a file manager does. Debounced, because it fires
   * on every keystroke.
   */
  useEffect(() => {
    if (!accountId || !searchActive) {
      setResults(null);
      setSearching(false);
      return;
    }

    const controller = new AbortController();
    setSearching(true);

    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ accountId });
      if (filters.text.trim()) params.set('q', filters.text.trim());
      if (filters.categories.length) params.set('categories', filters.categories.join(','));
      if (filters.scope === 'folder' && path !== '/') params.set('under', path);
      if (filters.starredOnly) params.set('starred', '1');
      if (filters.fullText) params.set('fullText', '1');

      if (filters.withinDays > 0) {
        const since = new Date(Date.now() - filters.withinDays * 86_400_000);
        params.set('since', since.toISOString());
      }

      const band = SIZE_BANDS[filters.size];
      if (band.min !== undefined) params.set('minSize', String(band.min));
      if (band.max !== undefined) params.set('maxSize', String(band.max));

      api<{ files: WorkspaceSearchFile[] }>(`/api/search?${params.toString()}`, {
        signal: controller.signal,
      })
        .then(({ files }) => setResults(files))
        .catch((err: Error) => {
          if (err.name === 'AbortError') return;
          setResults([]);
          setError(err instanceof ApiError ? err.message : 'Search failed');
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 350);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [accountId, path, filters, searchActive]);

  function contentUrl(file: OrbitFile, download: boolean): string {
    const query = new URLSearchParams({ accountId });
    if (download) {
      query.set('download', '1');
      query.set('name', file.name);
    }
    return `${API_BASE}/api/files/${encodeURIComponent(file.remoteId)}/content?${query.toString()}`;
  }

  async function createFolder(name: string) {
    setBusyId('new-folder');
    try {
      await api('/api/files/folder', { method: 'POST', body: { accountId, path, name } });
      setDialog(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the folder');
    } finally {
      setBusyId(null);
    }
  }

  async function rename(file: OrbitFile, name: string) {
    setBusyId(file.remoteId);
    try {
      await api(`/api/files/${encodeURIComponent(file.remoteId)}`, {
        method: 'PATCH',
        body: { accountId, name },
      });
      setDialog(null);
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
    setBusyId('delete');
    try {
      const result = await api<{ succeeded: string[]; failed: Array<{ remoteId: string; reason: string }> }>(
        '/api/files',
        { method: 'DELETE', body: { accountId, remoteIds: files.map((f) => f.remoteId) } },
      );
      if (result.failed.length > 0) {
        setError(`${result.failed.length} of ${files.length} could not be deleted.`);
      }
      setDialog(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete');
    } finally {
      setBusyId(null);
    }
  }

  /** Queues files; the panel picks them up and uploads them one at a time. */
  function enqueue(entries: Array<{ file: File; relativePath: string }>): void {
    if (entries.length === 0) return;

    const queued: UploadItem[] = entries.map(({ file, relativePath }) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      registerFile(id, file);
      return {
        id,
        relativePath,
        name: file.name,
        sizeBytes: file.size,
        uploadedBytes: 0,
        state: 'queued',
      };
    });

    setUploads((current) => [...current, ...queued]);
  }

  function fromInput(list: FileList | null): void {
    if (!list) return;
    enqueue(
      Array.from(list).map((file) => ({
        file,
        // A folder picker sets webkitRelativePath; a file picker does not.
        relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      })),
    );
  }

  async function onDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);

    // Walking the entries is what makes a dropped *folder* work; dataTransfer
    // .files alone silently yields nothing for one.
    const entries = await filesFromDataTransfer(event.dataTransfer.items);
    if (entries.length > 0) enqueue(entries);
    else fromInput(event.dataTransfer.files);
  }

  function toggleSelected(remoteId: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(remoteId)) next.delete(remoteId);
      else next.add(remoteId);
      return next;
    });
  }

  /** Search results when a search is running, otherwise the loaded folder. */
  const visible = useMemo(() => {
    const files: OrbitFile[] = searchActive ? (results ?? []) : (listing?.files ?? []);

    return [...files].sort((a, b) => {
      // Folders stay above files whatever the sort, the way a file manager does.
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      if (sort === 'size') return b.sizeBytes - a.sizeBytes;
      if (sort === 'modified') return Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt);
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
  }, [listing, results, searchActive, sort]);

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
    <div
      style={{ display: 'grid', gap: '1rem', position: 'relative' }}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        // Only when the pointer actually leaves the region, not on every child.
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(event) => void onDrop(event)}
    >
      {dragging && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 20,
            borderRadius: 'var(--radius-lg)',
            border: '2px dashed var(--accent)',
            background: 'var(--accent-soft)',
            display: 'grid',
            placeItems: 'center',
            fontWeight: 600,
            color: 'var(--accent)',
            pointerEvents: 'none',
          }}
        >
          Drop to upload here
        </div>
      )}

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
            className="clay-button clay-button--accent"
            style={{ padding: '0.4rem 1rem', fontSize: 13 }}
            onClick={() => fileInputRef.current?.click()}
          >
            Upload files
          </button>
          <button
            type="button"
            className="clay-button"
            style={{ padding: '0.4rem 1rem', fontSize: 13 }}
            onClick={() => folderInputRef.current?.click()}
          >
            Upload folder
          </button>
          <button
            type="button"
            className="clay-button"
            style={{ padding: '0.4rem 1rem', fontSize: 13 }}
            disabled={busyId !== null}
            onClick={() => setDialog({ kind: 'new-folder' })}
          >
            New folder
          </button>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            aria-label="Upload files"
            style={{ display: 'none' }}
            onChange={(event) => {
              fromInput(event.target.files);
              event.target.value = '';
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            // Not a standard attribute, so React needs it spelled this way.
            {...{ webkitdirectory: '', directory: '' }}
            aria-label="Upload folder"
            style={{ display: 'none' }}
            onChange={(event) => {
              fromInput(event.target.files);
              event.target.value = '';
            }}
          />
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
              onClick={() => setDialog({ kind: 'delete', files: selectedFiles })}
            >
              Delete {selectedFiles.length}
            </button>
          )}
        </div>

        <SearchBar
          filters={filters}
          onChange={setFilters}
          currentPath={path}
          searching={searching}
          resultCount={results?.length ?? null}
          fullTextSupported={capabilities?.fullTextSearch ?? false}
        />

        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, justifySelf: 'start' }}>
          <span style={{ color: 'var(--text-muted)' }}>Sort</span>
          <Select
            label="Sort by"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'name', label: 'Name' },
              { value: 'size', label: 'Size' },
              { value: 'modified', label: 'Modified' },
            ]}
          />
        </span>

        {error && (
          <p role="alert" style={{ color: 'var(--danger)', margin: 0, fontSize: 14 }}>
            {error}
          </p>
        )}
      </section>

      <section className="clay" style={{ padding: 'clamp(0.75rem, 2vw, 1.25rem)' }}>
        {loading && !listing && <p style={{ color: 'var(--text-muted)' }}>Loading…</p>}

        {!searchActive && listing && listing.files.length === 0 && (
          <p style={{ color: 'var(--text-muted)', padding: '1rem' }}>This folder is empty.</p>
        )}

        {searchActive && !searching && visible.length === 0 && (
          <div style={{ padding: '1rem', display: 'grid', gap: 8, justifyItems: 'start' }}>
            <p style={{ color: 'var(--text-muted)', margin: 0 }}>Nothing matched that search.</p>
            <button
              type="button"
              className="clay-button"
              style={{ padding: '0.35rem 0.9rem', fontSize: 13 }}
              onClick={() => setFilters({ ...EMPTY_FILTERS, scope: filters.scope })}
            >
              Clear search
            </button>
          </div>
        )}

        {visible.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 4 }} data-testid="file-list">
            {visible.map((file) => (
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
                <Checkbox
                  checked={selected.has(file.remoteId)}
                  onChange={() => toggleSelected(file.remoteId)}
                  aria-label={`Select ${file.name}`}
                />

                <FileIcon name={file.name} mimeType={file.mimeType} isFolder={file.isFolder} />

                <button
                  type="button"
                  onClick={() =>
                    file.isFolder ? navigate({ path: file.virtualPath }) : setPreviewing(file)
                  }
                  style={{
                    flex: 1,
                    minWidth: 0,
                    textAlign: 'left',
                    background: 'none',
                    border: 0,
                    font: 'inherit',
                    color: 'inherit',
                    cursor: 'pointer',
                    padding: 0,
                    display: 'grid',
                    gap: 1,
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {file.name}
                  </span>
                  {/* A result is far less useful without saying where it lives. */}
                  {searchActive && (
                    <span
                      style={{
                        fontSize: 11,
                        color: 'var(--text-muted)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {locationOf(file)}
                    </span>
                  )}
                </button>

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
                    onClick={() => setDialog({ kind: 'rename', file })}
                    style={{ padding: '0.35rem', display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}
                  >
                    <RenameIcon />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        {!searchActive && listing?.nextCursor && (
          <p style={{ color: 'var(--text-muted)', fontSize: 13, padding: '0.75rem' }}>
            Showing the first {listing.files.length} items of this folder. Search reaches the whole
            account, including subfolders.
          </p>
        )}
      </section>

      {uploads.length > 0 && (
        <UploadPanel
          accountId={accountId}
          path={path}
          items={uploads}
          setItems={setUploads}
          onComplete={() => {
            forgetFiles(uploads.map((item) => item.id));
            void load();
          }}
        />
      )}

      {dialog?.kind === 'new-folder' && (
        <NameDialog
          title="New folder"
          description={path === '/' ? 'Created in the root of this drive.' : `Created in ${path}.`}
          confirmLabel="Create"
          busy={busyId === 'new-folder'}
          onSubmit={(name) => void createFolder(name)}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog?.kind === 'rename' && (
        <NameDialog
          title="Rename"
          initialValue={dialog.file.name}
          confirmLabel="Rename"
          busy={busyId === dialog.file.remoteId}
          onSubmit={(name) => void rename(dialog.file, name)}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={
            dialog.files.length === 1
              ? `Delete ${dialog.files[0]!.name}?`
              : `Delete ${dialog.files.length} items?`
          }
          description="They move to the provider's own trash, where they can still be recovered."
          confirmLabel="Move to trash"
          destructive
          busy={busyId === 'delete'}
          onConfirm={() => void remove(dialog.files)}
          onClose={() => setDialog(null)}
        />
      )}

      {previewing && (
        <FilePreview
          file={previewing}
          siblings={visible}
          contentUrl={contentUrl}
          onSelect={setPreviewing}
          onClose={() => setPreviewing(null)}
        />
      )}
    </div>
  );
}
