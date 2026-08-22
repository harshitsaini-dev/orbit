import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { catalogueEntry, mimeForName, type OrbitFile } from '@orbit/shared-types';
import { FileGrid } from '../components/FileGrid.js';
import { FileIcon } from '../components/FileIcon.js';
import { FilePreview } from '../components/FilePreview.js';
import {
  FilterBox,
  SortControl,
  ViewToggle,
  useFileFilter,
  useFileSort,
  useListView,
} from '../components/ListControls.js';
import { CollectionsIcon } from '../components/Icons.js';
import { ConfirmDialog, NameDialog } from '../components/NameDialog.js';
import { ProviderIcon } from '../components/ProviderIcon.js';
import { Skeleton } from '../components/Skeleton.js';
import { StatusScreen, statusKindFor } from '../components/StatusScreen.js';
import { ApiError, api } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';

/**
 * Collections: files from any number of accounts, grouped without moving them.
 *
 * Two levels, like folders, because that is what fifty of them need. A row of
 * tabs and every file below it works for one collection and collapses at ten -
 * so the list is the page, and opening one replaces it. The open collection
 * lives in the URL, so it can be linked to and the back button works.
 *
 * Inside, a filter. A collection holding five hundred files is a place people
 * look things up in, not a list they read.
 */

interface Collection {
  id: string;
  name: string;
  itemCount: number;
  totalBytes: number;
  services: string[];
  createdAt: string;
}

interface Item {
  id: string;
  accountId: string;
  remoteId: string;
  accountNickname: string;
  provider: string;
  catalogueKey: string | null;
  name: string;
  mimeType: string;
  sizeBytes: number;
  isFolder: boolean;
  virtualPath: string;
}

const API_BASE = import.meta.env.VITE_API_URL ?? '';

/** Collections do not select, so the grid is handed one empty set for all time. */
const EMPTY_SELECTION: Set<string> = new Set();

/** A collection item is most of a file; the grid and the viewer want the rest. */
function asOrbitFile(item: Item): OrbitFile {
  return {
    remoteId: item.remoteId,
    name: item.name,
    virtualPath: item.virtualPath,
    mimeType: item.mimeType || mimeForName(item.name),
    sizeBytes: item.sizeBytes,
    isFolder: item.isFolder,
    starred: false,
    modifiedAt: new Date(0).toISOString(),
  };
}

export function Collections() {
  const [params, setParams] = useSearchParams();
  const openId = params.get('id');

  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [open, setOpen] = useState<{ collection: Collection; items: Item[] } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [viewMode, setViewMode] = useListView('collection');
  const [previewing, setPreviewing] = useState<Item | null>(null);
  const [listFilter, setListFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Collection | null>(null);
  const [deleting, setDeleting] = useState<Collection | null>(null);

  const load = useCallback(async () => {
    try {
      const { collections: rows } = await api<{ collections: Collection[] }>('/api/collections');
      setCollections(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Could not load collections'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const { filter, setFilter, shown: matching } = useFileFilter(open?.items ?? []);
  const { sort, setSort, descending, toggleDirection, sorted: shown } = useFileSort(
    'collection',
    matching,
  );

  useEffect(() => {
    if (!openId) {
      setOpen(null);
      setFilter('');
      setPreviewing(null);
      return;
    }

    const controller = new AbortController();
    api<{ collection: Collection; items: Item[] }>(`/api/collections/${openId}`, {
      signal: controller.signal,
    })
      .then(setOpen)
      .catch((err: Error) => {
        // A link to a collection that has been deleted goes back to the list
        // rather than showing an empty one.
        if (err.name !== 'AbortError') setParams({}, { replace: true });
      });

    return () => controller.abort();
  }, [openId, setParams, setFilter]);


  async function create(name: string): Promise<void> {
    const { collection } = await api<{ collection: Collection }>('/api/collections', {
      method: 'POST',
      body: { name },
    });
    setCreating(false);
    await load();
    setParams({ id: collection.id });
  }

  async function remove(collection: Collection): Promise<void> {
    await api(`/api/collections/${collection.id}`, { method: 'DELETE' });
    setDeleting(null);
    setParams({}, { replace: true });
    await load();
  }

  async function removeItem(itemId: string): Promise<void> {
    if (!open) return;
    await api(`/api/collections/${open.collection.id}/items/${itemId}`, { method: 'DELETE' });
    setOpen({ ...open, items: open.items.filter((item) => item.id !== itemId) });
    await load();
  }

  if (error && collections === null) {
    return (
      <StatusScreen
        kind={error instanceof ApiError ? statusKindFor(error.status) : 'server-error'}
        onRetry={() => void load()}
      />
    );
  }

  // --- one collection, opened ---------------------------------------------

  if (openId && open) {
    return (
      <div style={{ display: 'grid', gap: '1rem' }}>
        <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
          <button type="button" className="collection-back" onClick={() => setParams({})}>
            ‹ All collections
          </button>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '1rem',
              flexWrap: 'wrap',
              marginTop: '0.75rem',
            }}
          >
            <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
              <h1 style={{ fontSize: '1.4rem', margin: 0 }}>{open.collection.name}</h1>
              <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: 14 }}>
                {open.collection.itemCount} {open.collection.itemCount === 1 ? 'file' : 'files'} ·{' '}
                {formatBytes(open.collection.totalBytes)} · across{' '}
                {open.collection.services.length}{' '}
                {open.collection.services.length === 1 ? 'service' : 'services'}
              </p>
            </div>

            <span style={{ flex: 1 }} />

            <SortControl
              sort={sort}
              onSort={setSort}
              descending={descending}
              onToggleDirection={toggleDirection}
            />
            <ViewToggle view={viewMode} onChange={setViewMode} />

            <button type="button" className="clay-button" onClick={() => setRenaming(open.collection)}>
              Rename
            </button>
            <button
              type="button"
              className="clay-button"
              style={{ color: 'var(--danger)' }}
              onClick={() => setDeleting(open.collection)}
            >
              Delete
            </button>
          </div>

          <FilterBox value={filter} onChange={setFilter} count={open.items.length} />
        </section>

        <section className="clay" style={{ padding: '0.75rem' }}>
          {shown.length === 0 && (
            <p className="collection-empty">
              {open.items.length === 0
                ? 'Empty. Right-click a file in My Drive and choose “Add to collection”.'
                : `Nothing here matches “${filter}”.`}
            </p>
          )}

          {viewMode === 'grid' && shown.length > 0 && (
            <FileGrid
              files={shown.map(asOrbitFile)}
              accountIdFor={(file) =>
                shown.find((item) => item.remoteId === file.remoteId)?.accountId ?? ''
              }
              selected={EMPTY_SELECTION}
              onToggleSelect={() => undefined}
              onOpen={(file) => {
                const item = shown.find((entry) => entry.remoteId === file.remoteId);
                if (item && !item.isFolder) setPreviewing(item);
              }}
              // A collection spans accounts by definition, so where each file
              // lives is never redundant here the way it is inside one folder.
              showLocation
              locationOf={(file) =>
                shown.find((item) => item.remoteId === file.remoteId)?.accountNickname ?? ''
              }
            />
          )}

          {viewMode === 'list' && (
          <ul className="collection-items">
            {shown.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="dup-open"
                  title={item.isFolder ? 'Open where it lives' : 'Open it'}
                  onClick={() => (item.isFolder ? undefined : setPreviewing(item))}
                >
                  <FileIcon
                    name={item.name}
                    mimeType={item.mimeType}
                    isFolder={item.isFolder}
                    size={22}
                  />
                </button>

                <a
                  className="collection-item__name"
                  href={`/my-drive?account=${encodeURIComponent(item.accountId)}&path=${encodeURIComponent(
                    item.virtualPath.slice(0, item.virtualPath.lastIndexOf('/')) || '/',
                  )}`}
                >
                  <strong>{item.name}</strong>
                  <span>{item.virtualPath}</span>
                </a>

                <span className="collection-item__where">
                  <ProviderIcon provider={item.catalogueKey ?? item.provider} size={16} />
                  <span>{catalogueEntry(item.catalogueKey ?? '')?.label ?? item.provider}</span>
                  <span>· {item.accountNickname}</span>
                </span>

                <span className="collection-item__size">
                  {item.isFolder ? '' : formatBytes(item.sizeBytes)}
                </span>

                <button
                  type="button"
                  className="clay-button"
                  // "Remove", not "delete": this takes the reference out and
                  // leaves the file exactly where it is.
                  title="Remove from this collection. The file itself is untouched."
                  onClick={() => void removeItem(item.id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          )}
        </section>

        {previewing && (
          <FilePreview
            file={asOrbitFile(previewing)}
            // The collection is the set to step through: that is what somebody
            // grouped these files for.
            siblings={shown.filter((item) => !item.isFolder).map(asOrbitFile)}
            contentUrl={(file, download) => {
              const owner =
                shown.find((item) => item.remoteId === file.remoteId)?.accountId ??
                previewing.accountId;
              const query = new URLSearchParams({ accountId: owner });
              if (download) {
                query.set('download', '1');
                query.set('name', file.name);
              }
              return `${API_BASE}/api/files/${encodeURIComponent(file.remoteId)}/content?${query.toString()}`;
            }}
            onSelect={(next) => {
              const item = shown.find((entry) => entry.remoteId === next.remoteId);
              if (item) setPreviewing(item);
            }}
            onClose={() => setPreviewing(null)}
          />
        )}

        {renaming && (
          <NameDialog
            title="Rename collection"
            initialValue={renaming.name}
            confirmLabel="Rename"
            onSubmit={(name) => {
              void api(`/api/collections/${renaming.id}`, { method: 'PATCH', body: { name } }).then(
                async () => {
                  setRenaming(null);
                  await load();
                  setOpen((current) =>
                    current ? { ...current, collection: { ...current.collection, name } } : current,
                  );
                },
              );
            }}
            onClose={() => setRenaming(null)}
          />
        )}

        {deleting && (
          <ConfirmDialog
            title={`Delete “${deleting.name}”?`}
            description="The collection goes; the files it points at stay exactly where they are."
            confirmLabel="Delete collection"
            destructive
            onConfirm={() => void remove(deleting)}
            onClose={() => setDeleting(null)}
          />
        )}
      </div>
    );
  }

  // --- the list ------------------------------------------------------------

  const needle = listFilter.trim().toLowerCase();
  const shownCollections = (collections ?? []).filter((collection) =>
    collection.name.toLowerCase().includes(needle),
  );

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'grid', gap: 4 }}>
            <h1 style={{ fontSize: '1.4rem', margin: 0 }}>Collections</h1>
            <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: 14 }}>
              Group files from any of your accounts. Nothing is moved or copied — a collection
              points at files where they already are.
            </p>
          </div>

          <span style={{ flex: 1 }} />

          <button
            type="button"
            className="clay-button clay-button--accent"
            onClick={() => setCreating(true)}
          >
            New collection
          </button>
        </div>

        {/* Fifty collections is a list you look things up in too, not only the
            files inside one. */}
        <FilterBox
          value={listFilter}
          onChange={setListFilter}
          count={collections?.length ?? 0}
          noun="collections"
        />
      </section>

      {collections === null && (
        <ul className="collection-grid" aria-busy="true" aria-label="Loading collections">
          {Array.from({ length: 4 }, (_, index) => (
            <li key={index}>
              <span className="clay" style={{ display: 'grid', gap: 8, padding: '1rem 1.1rem' }}>
                <Skeleton width={40} height={40} radius="12px" />
                <Skeleton width={`${52 + ((index * 11) % 30)}%`} height={14} />
                <Skeleton width="42%" height={11} />
              </span>
            </li>
          ))}
        </ul>
      )}

      {collections?.length === 0 && (
        <section
          className="clay"
          style={{ padding: 'clamp(1.5rem, 4vw, 2.5rem)', textAlign: 'center' }}
        >
          <p style={{ color: 'var(--text-muted)', margin: 0, lineHeight: 1.6 }}>
            Nothing yet. Make one, then right-click any file in My Drive and add it — a tax folder
            can hold a PDF from one account and a spreadsheet from another without either of them
            moving.
          </p>
        </section>
      )}

      {shownCollections.length === 0 && (collections?.length ?? 0) > 0 && (
        <section className="clay" style={{ padding: '1.25rem', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>
            No collection matches “{listFilter}”.
          </p>
        </section>
      )}

      {shownCollections.length > 0 && (
        <ul className="collection-grid">
          {shownCollections.map((collection) => (
            <li key={collection.id}>
              <button type="button" onClick={() => setParams({ id: collection.id })}>
                <span className="collection-card__icon">
                  <CollectionsIcon size={22} />
                </span>

                <span className="collection-card__name">{collection.name}</span>

                <span className="collection-card__meta">
                  {collection.itemCount} {collection.itemCount === 1 ? 'file' : 'files'}
                  {collection.totalBytes > 0 && ` · ${formatBytes(collection.totalBytes)}`}
                </span>

                {/* Which clouds it spans, without opening it. */}
                <span className="collection-card__services">
                  {collection.services.slice(0, 4).map((service) => (
                    <ProviderIcon key={service} provider={service} size={15} />
                  ))}
                  {collection.services.length > 4 && <span>+{collection.services.length - 4}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <NameDialog
          title="New collection"
          description="A name you will recognise later — “Tax Documents 2026”, “Client work”."
          confirmLabel="Create"
          onSubmit={(name) => void create(name)}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}
