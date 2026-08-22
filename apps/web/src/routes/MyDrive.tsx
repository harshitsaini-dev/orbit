import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { catalogueEntry } from '@orbit/shared-types';
import type { OrbitFile, ProviderCapabilities, PublicAccount } from '@orbit/shared-types';
import { DownloadIcon, OpenIcon, RenameIcon, ShareIcon, StarIcon, TransferIcon } from '../components/ActionIcon.js';
import { FileIcon } from '../components/FileIcon.js';
import { FilePreview } from '../components/FilePreview.js';
import { Checkbox } from '../components/Checkbox.js';
import { ContextMenu, useContextMenu, type MenuItem } from '../components/ContextMenu.js';
import { DropZone } from '../components/DropZone.js';
import { AddToCollection } from '../components/AddToCollection.js';
import { DragSelectBox, useDragSelect } from '../components/DragSelect.js';
import { FileDetails } from '../components/FileDetails.js';
import { FolderPicker } from '../components/FolderPicker.js';
import { TransferDialog } from '../components/TransferDialog.js';
import { ShareDialog } from '../components/ShareDialog.js';
import { FileGrid } from '../components/FileGrid.js';
import {
  CollectionsIcon,
  NewFolderIcon,
  RefreshIcon,
  TrashIcon,
  UpIcon,
  UploadFileIcon,
  UploadFolderIcon,
  CopyIcon,
  MoveIcon,
  InfoIcon,
} from '../components/Icons.js';
import { ViewToggle, useViewMode } from '../components/ViewToggle.js';
import { PHONE, useMediaQuery } from '../lib/media.js';
import { ConfirmDialog, NameDialog } from '../components/NameDialog.js';
import { Pagination } from '../components/Pagination.js';
import { Select } from '../components/Select.js';
import { FileGridSkeleton, FileListSkeleton } from '../components/Skeleton.js';
import { StatusScreen, statusKindFor } from '../components/StatusScreen.js';
import {
  EMPTY_FILTERS,
  SIZE_BANDS,
  SearchBar,
  hasCriteria,
  type SearchFilters,
} from '../components/SearchBar.js';
import { filesFromDataTransfer } from '../lib/upload.js';
import { ProviderIcon } from '../components/ProviderIcon.js';
import { api, ApiError } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';
import { forgetFolder, readFolder, writeFolder } from '../lib/cache.js';
import { previewKindFor } from '../lib/preview.js';
import { useUploads } from '../lib/uploads.js';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

/**
 * A ceiling on how much of one folder is pulled into the page. Well past any
 * folder a person browses, and short of the point where the browser struggles.
 */
const MAX_FOLDER_ITEMS = 5000;

/**
 * The same ceiling for search results. The *matching* happens at the provider
 * over every file in the account, however many there are — this only bounds how
 * many matches are held in the page at once.
 */
const MAX_SEARCH_RESULTS = 5000;

/** Rows per page. Past this a single list is slow to render and worse to read. */
const PAGE_SIZE = 1000;

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
  // The listing failure specifically, kept as the error object so the file area
  // can show the screen that explains it. Everything else here is inline: the
  // breadcrumbs, the account switcher and the toolbar all stay useful when one
  // folder will not open, and replacing the page would take them away.
  const [listError, setListError] = useState<Error | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewing, setPreviewing] = useState<OrbitFile | null>(null);
  /** A refresh behind a cached listing, which must not blank the page. */
  const [refreshing, setRefreshing] = useState(false);
  const phone = useMediaQuery(PHONE);

  // Dialogs replace window.prompt and window.confirm, which the browser draws
  // itself, ignore the theme, and on some platforms suppress outright.
  const [dialog, setDialog] = useState<
    | { kind: 'new-folder' }
    | { kind: 'rename'; file: OrbitFile }
    | { kind: 'delete'; files: OrbitFile[] }
    | null
  >(null);

  const uploads = useUploads();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const [filters, setFilters] = useState<SearchFilters>(EMPTY_FILTERS);
  const [results, setResults] = useState<WorkspaceSearchFile[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [sort, setSort] = useState<'name' | 'size' | 'modified'>('name');
  const [viewMode, setViewMode] = useViewMode();
  const [loadingMore, setLoadingMore] = useState(false);

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

    setError(null);
    setListError(null);

    // Paint from the cache first, then refresh behind it. A folder that was
    // opened before appears at once instead of after a round trip - and with
    // several accounts connected, that round trip is per account.
    const cached = await readFolder(accountId, path);
    if (cached) {
      setListing({ files: cached.files, nextCursor: undefined } as Listing);
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const result = await api<Listing>(
        `/api/files?accountId=${encodeURIComponent(accountId)}&path=${encodeURIComponent(path)}`,
      );
      setListing(result);
      // Marked partial when there is more to fetch, so nothing later mistakes
      // the first page for the whole folder.
      void writeFolder(accountId, path, result.files, Boolean(result.nextCursor));
    } catch (err) {
      if (!cached) setListing(null);
      // A revoked grant has a specific remedy, so it keeps its specific message
      // instead of becoming a generic screen.
      if (err instanceof ApiError && err.code === 'needs_reauth') {
        setError('This account needs reconnecting. Open Quota to reconnect it.');
      } else if (!cached) {
        setListError(err instanceof Error ? err : new Error('Could not list this folder'));
      }
      // With a cached copy on screen the failure is not fatal: the folder is
      // still browsable, it is just not fresh. Replacing it with an error would
      // take away something that was working.
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [accountId, path]);

  useEffect(() => {
    void load();
  }, [load]);

  // The queue lives above the router now, so the open folder has to be told a
  // batch landed rather than finding out because it owned the uploader.
  useEffect(() => uploads.onFinished(() => void load()), [uploads, load]);

  /**
   * A folder is not its first page. The first page renders immediately and the
   * rest is fetched behind it, so a large folder is usable straight away rather
   * than either truncated at 200 items or blank until every page has landed.
   *
   * Capped, because a folder with a hundred thousand files would otherwise pull
   * the lot into the page; the count below says when that happened.
   */
  useEffect(() => {
    if (!listing?.nextCursor || !accountId) return;
    if (listing.path !== path) return;

    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      setLoadingMore(true);
      let cursor: string | undefined = listing.nextCursor;

      try {
        while (cursor && !cancelled) {
          const next: Listing = await api<Listing>(
            `/api/files?accountId=${encodeURIComponent(accountId)}&path=${encodeURIComponent(path)}&pageToken=${encodeURIComponent(cursor)}`,
            { signal: controller.signal },
          );

          if (cancelled) return;

          let reachedCap = false;

          setListing((current) => {
            // The folder changed under us; this page belongs to the old one.
            if (!current || current.path !== path) return current;

            const combined = [...current.files, ...next.files];
            reachedCap = combined.length >= MAX_FOLDER_ITEMS;

            return {
              ...current,
              files: reachedCap ? combined.slice(0, MAX_FOLDER_ITEMS) : combined,
              nextCursor: reachedCap ? undefined : next.nextCursor,
            };
          });

          cursor = reachedCap ? undefined : next.nextCursor;
        }
      } catch (err) {
        // A failed continuation leaves what already loaded in place; the count
        // still shows more exists.
        if ((err as Error).name !== 'AbortError') {
          setError('Could not load the rest of this folder.');
        }
      } finally {
        if (!cancelled) setLoadingMore(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // Keyed on the cursor, so each completed page starts the next.
  }, [accountId, path, listing?.nextCursor, listing?.path]);

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

      void (async () => {
        const collected: WorkspaceSearchFile[] = [];
        let cursor: string | undefined;

        try {
          do {
            const query = new URLSearchParams(params);
            if (cursor) query.set('cursor', cursor);

            const page: { files: WorkspaceSearchFile[]; nextCursor?: string } = await api(
              `/api/search?${query.toString()}`,
              { signal: controller.signal },
            );

            collected.push(...page.files);
            // Shown as they arrive, so a broad search is readable immediately
            // rather than blank until every page has landed.
            setResults([...collected]);

            cursor = collected.length >= MAX_SEARCH_RESULTS ? undefined : page.nextCursor;
          } while (cursor);
        } catch (err) {
          if ((err as Error).name === 'AbortError') return;
          setResults([]);
          setError(err instanceof ApiError ? err.message : 'Search failed');
        } finally {
          if (!controller.signal.aborted) setSearching(false);
        }
      })();
    }, 350);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [accountId, path, filters, searchActive]);

  const menu = useContextMenu<OrbitFile>();
  const [sharing, setSharing] = useState<OrbitFile | null>(null);
  const [collecting, setCollecting] = useState<OrbitFile | null>(null);
  const [transferring, setTransferring] = useState<{ file: OrbitFile; mode: 'copy' | 'move' } | null>(
    null,
  );
  const [relocating, setRelocating] = useState<{ file: OrbitFile; mode: 'copy' | 'move' } | null>(
    null,
  );
  const [detailing, setDetailing] = useState<OrbitFile | null>(null);

  /**
   * What the right-click menu offers for one file. Built here rather than in
   * the menu so the list and the grid cannot drift apart, and so an action the
   * provider cannot do is shown greyed rather than hidden - absence looks like
   * a bug, a disabled row reads as a limit.
   */
  function menuItemsFor(file: OrbitFile): MenuItem[] {
    return [
      {
        label: file.isFolder ? 'Open' : 'Preview',
        icon: <OpenIcon />,
        onSelect: () =>
          file.isFolder ? navigate({ path: file.virtualPath }) : setPreviewing(file),
        disabled: !file.isFolder && previewKindFor(file) === 'none',
      },
      {
        label: 'Download',
        icon: <DownloadIcon />,
        onSelect: () => {
          // A hidden anchor rather than location.assign, so the download does
          // not count as a navigation and the page stays where it is.
          const link = document.createElement('a');
          link.href = contentUrl(file, true);
          link.download = file.name;
          link.click();
        },
        disabled: file.isFolder,
      },
      {
        label: file.starred ? 'Remove star' : 'Add star',
        icon: <StarIcon filled={file.starred} />,
        onSelect: () => void toggleStar(file),
      },
      {
        label: 'Share link',
        icon: <ShareIcon />,
        onSelect: () => setSharing(file),
        // A folder has no single stream to serve, so there is nothing to share.
        disabled: file.isFolder,
      },
      /*
       * Four ways to put a file somewhere else, split along the two axes that
       * actually differ: whether the original survives, and whether the bytes
       * have to travel.
       *
       * Inside one drive the provider does the work itself and nothing is
       * downloaded. Across two drives the bytes go through Orbit, which is
       * slower and worth being a separate, differently-named action rather than
       * a checkbox somebody might not read.
       */
      {
        label: 'Copy to folder…',
        icon: <CopyIcon />,
        onSelect: () => setRelocating({ file, mode: 'copy' }),
        disabled: !capabilities?.relocate,
      },
      {
        label: 'Move to folder…',
        icon: <MoveIcon />,
        onSelect: () => setRelocating({ file, mode: 'move' }),
        disabled: !capabilities?.relocate,
      },
      {
        label: 'Copy to another cloud',
        icon: <TransferIcon />,
        onSelect: () => setTransferring({ file, mode: 'copy' }),
        // A folder has no single stream to move; the files inside it do.
        disabled: file.isFolder || (accounts?.length ?? 0) < 2,
      },
      {
        label: 'Move to another cloud',
        icon: <TransferIcon />,
        onSelect: () => setTransferring({ file, mode: 'move' }),
        disabled: file.isFolder || (accounts?.length ?? 0) < 2,
      },
      {
        label: 'Add to collection',
        icon: <CollectionsIcon size={16} />,
        onSelect: () => setCollecting(file),
      },
      {
        label: 'Rename',
        icon: <RenameIcon />,
        onSelect: () => setDialog({ kind: 'rename', file }),
      },
      {
        label: 'Details',
        icon: <InfoIcon />,
        onSelect: () => setDetailing(file),
      },
      {
        // Named for what it does on this provider, not for what delete usually
        // means: on a bucket there is no bin behind it.
        label: capabilities?.trash ? 'Move to bin' : 'Delete for ever',
        icon: <TrashIcon />,
        danger: true,
        onSelect: () => setDialog({ kind: 'delete', files: [file] }),
      },
    ];
  }

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
      await forgetFolder(accountId, path);
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
      await forgetFolder(accountId, path);
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
      await forgetFolder(accountId, path);
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
      await forgetFolder(accountId, path);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete');
    } finally {
      setBusyId(null);
    }
  }

  /** Hands files to the app-level queue, which reports from the header. */
  function enqueue(entries: Array<{ file: File; relativePath: string }>): void {
    if (entries.length === 0 || !accountId) return;
    const account = accounts?.find((candidate) => candidate.id === accountId);
    uploads.enqueue(entries, {
      accountId,
      path,
      // The catalogue key, not the adapter id: five entries run on the s3
      // adapter, so "s3" would name a bucket on R2 and one on Backblaze
      // identically.
      provider:
        catalogueEntry(account?.catalogueKey ?? '')?.label ?? account?.provider ?? 'this account',
      label: account?.nickname ?? 'this account',
    });
  }

  function fromInput(list: FileList | File[] | null): void {
    if (!list) return;
    enqueue(
      Array.from(list).map((file) => ({
        file,
        // A folder picker sets webkitRelativePath; a file picker does not.
        relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      })),
    );
  }

  const onDropped = useCallback(
    async (files: File[], transfer: DataTransfer) => {
      // Walking the entries is what makes a dropped *folder* work; dataTransfer
      // .files alone silently yields nothing for one.
      const entries = await filesFromDataTransfer(transfer.items);
      if (entries.length > 0) enqueue(entries);
      else fromInput(files);
    },
    // enqueue and fromInput are stable for a given folder, and re-creating this
    // on every render would re-bind the window listeners each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accountId, path],
  );

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

  // Selection follows what is on screen: selecting all while a search is
  // running should mean the results, not the folder behind them.
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, Number(params.get('page')) || 1), pageCount);
  // One page at a time reaches the DOM; the rest is held but not rendered.
  const paged = pageCount > 1 ? visible.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE) : visible;

  function goToPage(next: number): void {
    const updated = new URLSearchParams(params);
    if (next <= 1) updated.delete('page');
    else updated.set('page', String(next));
    setParams(updated, { replace: false });
    setSelected(new Set());
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Selection and select-all follow what is on screen, which is one page.
  /**
   * Drag a box over files to select them, as every file manager does.
   *
   * Off while a dialog or the viewer is open: a drag behind a modal is a
   * selection nobody can see changing.
   */
  const { containerRef, box } = useDragSelect({
    enabled: !dialog && !previewing && !sharing && !transferring && !relocating && !detailing,
    onSelect: (keys, additive) =>
      setSelected((current) => (additive ? new Set([...current, ...keys]) : new Set(keys))),
    onClear: () => setSelected(new Set()),
  });

  const selectedFiles = paged.filter((file) => selected.has(file.remoteId));
  const allVisibleSelected = paged.length > 0 && selectedFiles.length === paged.length;

  function toggleSelectAll(): void {
    setSelected(allVisibleSelected ? new Set() : new Set(paged.map((file) => file.remoteId)));
  }

  if (accounts?.length === 0) {
    return (
      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
        <h1 className="page-title">My Drive</h1>
        <p className="page-subtitle">
          No accounts connected yet. Open Quota to connect one.
        </p>
      </section>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ display: 'grid', gap: '1rem', position: 'relative' }}
    >
      <DragSelectBox box={box} />

      <DropZone
        label={path === '/' ? 'Upload to this drive' : `Upload to ${path}`}
        onFiles={(files, transfer) => void onDropped(files, transfer)}
        // Nowhere to put them until an account is chosen, and an overlay that
        // promises an upload it cannot perform is worse than none.
        disabled={!accountId}
      />

      <section className="clay" style={{ padding: 'clamp(1rem, 3vw, 1.5rem)', display: 'grid', gap: '0.9rem' }}>
        {accounts && accounts.length > 1 && (
          /*
           * A row of drives on a desk, one menu on a phone.
           *
           * The strip is the better control when it fits: every drive visible,
           * one tap to switch. On a phone it does not fit, and it sat directly
           * under the navigation - which is also a horizontal scroller there -
           * so the page had two of them stacked and a sideways swipe was a
           * guess about which one would move.
           */
          phone ? (
            <Select
              label="Drive"
              value={accountId ?? ''}
              onChange={(next) => navigate({ account: next, path: '/' })}
              options={accounts.map((account) => ({
                value: account.id,
                label: account.nickname,
              }))}
            />
          ) : (
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
                    boxShadow:
                      account.id === accountId ? 'var(--shadow-clay-inset)' : 'var(--shadow-clay)',
                  }}
                >
                  <ProviderIcon provider={account.catalogueKey ?? account.provider} size={18} />
                  {account.nickname}
                </button>
              ))}
            </div>
          )
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
              className="clay-button icon-button"
              style={{ padding: '0.4rem 1rem', fontSize: 13 }}
              aria-label="Go up one folder"
              onClick={() => navigate({ path: parentOf(path) })}
            >
              <UpIcon size={16} />
              <span className="btn-label">Up</span>
            </button>
          )}
          <button
            type="button"
            className="clay-button clay-button--accent icon-button"
            style={{ padding: '0.4rem 1rem', fontSize: 13 }}
            onClick={() => fileInputRef.current?.click()}
          >
            <UploadFileIcon size={16} />
            Upload files
          </button>
          <button
            type="button"
            className="clay-button icon-button"
            style={{ padding: '0.4rem 1rem', fontSize: 13 }}
            // The browser asks for confirmation before handing over a whole
            // folder, and no page can suppress that - it is a permission
            // prompt, not a dialog. Saying so beforehand stops it reading as
            // something Orbit did. Dragging the folder in avoids it entirely,
            // because a drop carries the files without a picker.
            title="Your browser will ask before handing over a folder. Dragging it in skips that."
            aria-label="Upload folder"
            onClick={() => folderInputRef.current?.click()}
          >
            <UploadFolderIcon size={16} />
            <span className="btn-label">Upload folder</span>
          </button>
          <button
            type="button"
            className="clay-button icon-button"
            style={{ padding: '0.4rem 1rem', fontSize: 13 }}
            disabled={busyId !== null}
            aria-label="New folder"
            onClick={() => setDialog({ kind: 'new-folder' })}
          >
            <NewFolderIcon size={16} />
            <span className="btn-label">New folder</span>
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
            className="clay-button icon-button"
            style={{ padding: '0.4rem 1rem', fontSize: 13 }}
            disabled={loading}
            aria-label="Refresh this folder"
            onClick={() => void load()}
          >
            <RefreshIcon size={16} />
            <span className="btn-label">Refresh</span>
          </button>

          {selectedFiles.length > 0 && (
            <button
              type="button"
              className="clay-button icon-button"
              style={{ padding: '0.4rem 1rem', fontSize: 13, color: 'var(--danger)' }}
              disabled={busyId !== null}
              onClick={() => setDialog({ kind: 'delete', files: selectedFiles })}
            >
              <TrashIcon size={16} />
              {capabilities?.trash ? 'Bin' : 'Delete'} {selectedFiles.length}
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

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
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

          <ViewToggle value={viewMode} onChange={setViewMode} />

        </div>

        {error && (
          <p role="alert" style={{ color: 'var(--danger)', margin: 0, fontSize: 14 }}>
            {error}
          </p>
        )}
      </section>

      <section className="clay" style={{ padding: 'clamp(0.75rem, 2vw, 1.25rem)' }}>
        {/*
          * Select-all belongs to the list, not to the toolbar.
          *
          * It was a row of its own above the search box, which on a phone was
          * another thirty-six pixels of chrome - and it was describing rows the
          * reader could not see yet. Bin has always had it here; now they agree.
          */}
        {visible.length > 0 && (
          <div className="list-select-all">
            <Checkbox
              checked={allVisibleSelected}
              onChange={toggleSelectAll}
              label={
                selectedFiles.length > 0
                  ? `${selectedFiles.length} selected`
                  : pageCount > 1
                    ? `Select page (${paged.length})`
                    : `Select all ${visible.length}`
              }
            />
          </div>
        )}

        {listError && !loading && (
          <StatusScreen
            kind={listError instanceof ApiError ? statusKindFor(listError.status) : 'server-error'}
            onRetry={() => void load()}
          />
        )}

        {!listError && ((loading && !listing) || (searching && !results)) ? (
          viewMode === 'grid' ? <FileGridSkeleton /> : <FileListSkeleton />
        ) : null}

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

        {pageCount > 1 && (
          <Pagination
            page={currentPage}
            pageCount={pageCount}
            totalItems={visible.length}
            pageSize={PAGE_SIZE}
            onChange={goToPage}
          />
        )}

        {paged.length > 0 && viewMode === 'grid' && (
          <FileGrid
            files={paged}
            accountIdFor={() => accountId}
            selected={selected}
            onToggleSelect={toggleSelected}
            onOpen={(file) => (file.isFolder ? navigate({ path: file.virtualPath }) : setPreviewing(file))}
            showLocation={searchActive}
            locationOf={locationOf}
            onContextMenu={(event, file) => menu.open(event, file)}
          />
        )}

        {paged.length > 0 && viewMode === 'list' && (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 4 }} data-testid="file-list">
            {paged.map((file) => (
              <li
                key={file.remoteId}
                data-file={file.remoteId}
                data-selected={selected.has(file.remoteId) ? '' : undefined}
                onContextMenu={(event) => menu.open(event, file)}
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
                  <span
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      overflow: 'hidden',
                      minWidth: 0,
                    }}
                  >
                    <span
                      style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {file.name}
                    </span>

                    {file.shared && (
                      <span
                        className="shared-badge shared-badge--inline"
                        title="Anyone with the link can open this"
                      >
                        <ShareIcon />
                      </span>
                    )}
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

        {pageCount > 1 && (
          <Pagination
            page={currentPage}
            pageCount={pageCount}
            totalItems={visible.length}
            pageSize={PAGE_SIZE}
            onChange={goToPage}
          />
        )}

        {!searchActive && listing && listing.files.length > 0 && (
          <p style={{ color: 'var(--text-muted)', fontSize: 13, padding: '0.75rem' }} aria-live="polite">
            {refreshing
              ? `${listing.files.length} items · checking for changes…`
              : loadingMore
              ? `${listing.files.length} items so far, still loading…`
              : listing.files.length >= MAX_FOLDER_ITEMS
                ? `Showing ${MAX_FOLDER_ITEMS.toLocaleString()} items. This folder holds more than Orbit will load at once — use search to find something specific.`
                : `${listing.files.length} ${listing.files.length === 1 ? 'item' : 'items'}`}
          </p>
        )}

        {searchActive && results && results.length >= MAX_SEARCH_RESULTS && (
          <p style={{ color: 'var(--warning)', fontSize: 13, padding: '0.75rem' }}>
            More than {MAX_SEARCH_RESULTS.toLocaleString()} files matched. The search itself covered
            every file in the account — this is only how many matches are held at once. Narrow it
            with a filter to see the rest.
          </p>
        )}
      </section>

      {transferring && (
        <TransferDialog
          file={transferring.file}
          mode={transferring.mode}
          fromAccountId={accountId}
          accounts={accounts ?? []}
          onClose={() => setTransferring(null)}
          onQueued={() => undefined}
        />
      )}

      {detailing && (
        <FileDetails
          file={detailing}
          account={accounts?.find((entry) => entry.id === accountId)}
          onClose={() => setDetailing(null)}
        />
      )}

      {relocating && (
        <FolderPicker
          file={relocating.file}
          accountId={accountId}
          mode={relocating.mode}
          currentFolder={path}
          onClose={() => setRelocating(null)}
          onDone={() => {
            setRelocating(null);
            void load();
          }}
        />
      )}

      {collecting && (
        <AddToCollection file={collecting} accountId={accountId} onClose={() => setCollecting(null)} />
      )}

      {sharing && (
        <ShareDialog
          file={sharing}
          accountId={accountId}
          apiBase={API_BASE}
          onClose={() => setSharing(null)}
        />
      )}

      {menu.state && (
        <ContextMenu
          anchor={menu.state.anchor}
          items={menuItemsFor(menu.state.target)}
          onClose={menu.close}
          label={`Actions for ${menu.state.target.name}`}
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
        /*
         * The wording follows the provider, because the two are different acts.
         *
         * Drive and Dropbox keep a bin, so this is reversible and should say
         * so. An object store has none: the file is gone the moment the button
         * is pressed. Calling both "Move to bin" is a promise Orbit cannot keep
         * on half its providers, and the half it breaks it on is the half where
         * being wrong costs the most.
         */
        <ConfirmDialog
          title={
            dialog.files.length === 1
              ? `Delete ${dialog.files[0]!.name}?`
              : `Delete ${dialog.files.length} items?`
          }
          description={
            capabilities?.trash
              ? "They move to the provider's own bin, where they can still be recovered. Orbit's Bin page lists them."
              : 'This provider keeps no bin. They are gone the moment you confirm, and nobody — including the provider — can bring them back.'
          }
          confirmLabel={capabilities?.trash ? 'Move to bin' : 'Delete for ever'}
          destructive
          busy={busyId === 'delete'}
          onConfirm={() => void remove(dialog.files)}
          onClose={() => setDialog(null)}
        />
      )}

      {previewing && (
        <FilePreview
          file={previewing}
          siblings={paged}
          contentUrl={contentUrl}
          onSelect={setPreviewing}
          onClose={() => setPreviewing(null)}
        />
      )}
    </div>
  );
}
