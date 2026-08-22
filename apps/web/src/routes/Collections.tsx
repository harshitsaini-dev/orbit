import { useCallback, useEffect, useState } from 'react';
import { catalogueEntry } from '@orbit/shared-types';
import { FileIcon } from '../components/FileIcon.js';
import { NameDialog } from '../components/NameDialog.js';
import { ProviderIcon } from '../components/ProviderIcon.js';
import { StatusScreen, statusKindFor } from '../components/StatusScreen.js';
import { ApiError, api } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';

/**
 * Collections: files from any number of accounts, grouped without moving them.
 *
 * The provider badge on every row is the point rather than decoration — a
 * collection is the one place where files from different clouds sit together,
 * and "where is this really" is the question that follows immediately.
 */

interface Collection {
  id: string;
  name: string;
  itemCount: number;
  createdAt: string;
}

interface Item {
  id: string;
  accountId: string;
  accountNickname: string;
  provider: string;
  catalogueKey: string | null;
  name: string;
  mimeType: string;
  sizeBytes: number;
  isFolder: boolean;
  virtualPath: string;
}

export function Collections() {
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Collection | null>(null);

  const load = useCallback(async () => {
    try {
      const { collections: rows } = await api<{ collections: Collection[] }>('/api/collections');
      setCollections(rows);
      setError(null);
      // Land on the first one rather than making an empty choice.
      setOpenId((current) => current ?? rows[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Could not load collections'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!openId) {
      setItems(null);
      return;
    }

    const controller = new AbortController();
    api<{ items: Item[] }>(`/api/collections/${openId}`, { signal: controller.signal })
      .then(({ items: rows }) => setItems(rows))
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setItems([]);
      });

    return () => controller.abort();
  }, [openId]);

  async function create(name: string): Promise<void> {
    const { collection } = await api<{ collection: Collection }>('/api/collections', {
      method: 'POST',
      body: { name },
    });
    setCreating(false);
    await load();
    setOpenId(collection.id);
  }

  async function remove(id: string): Promise<void> {
    await api(`/api/collections/${id}`, { method: 'DELETE' });
    if (openId === id) setOpenId(null);
    await load();
  }

  async function removeItem(itemId: string): Promise<void> {
    if (!openId) return;
    await api(`/api/collections/${openId}/items/${itemId}`, { method: 'DELETE' });
    setItems((current) => current?.filter((item) => item.id !== itemId) ?? null);
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

  const open = collections?.find((collection) => collection.id === openId) ?? null;

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

          <button type="button" className="clay-button clay-button--accent" onClick={() => setCreating(true)}>
            New collection
          </button>
        </div>

        {collections && collections.length > 0 && (
          <div className="collection-tabs" role="tablist" aria-label="Collections">
            {collections.map((collection) => (
              <button
                key={collection.id}
                type="button"
                role="tab"
                aria-selected={collection.id === openId}
                onClick={() => setOpenId(collection.id)}
              >
                {collection.name}
                <span>{collection.itemCount}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {collections?.length === 0 && (
        <section className="clay" style={{ padding: 'clamp(1.5rem, 4vw, 2.5rem)', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-muted)', margin: 0, lineHeight: 1.6 }}>
            Nothing yet. Make one, then right-click any file in My Drive and add it — a tax folder
            can hold a PDF from one account and a spreadsheet from another without either of them
            moving.
          </p>
        </section>
      )}

      {open && (
        <section className="clay" style={{ padding: '0.75rem' }}>
          <div className="collection-head">
            <strong>{open.name}</strong>
            <span>
              {open.itemCount} {open.itemCount === 1 ? 'item' : 'items'}
            </span>
            <span style={{ flex: 1 }} />
            <button type="button" className="clay-button" onClick={() => setRenaming(open)}>
              Rename
            </button>
            <button
              type="button"
              className="clay-button"
              style={{ color: 'var(--danger)' }}
              onClick={() => void remove(open.id)}
            >
              Delete collection
            </button>
          </div>

          {items === null && <p className="collection-empty">Loading…</p>}

          {items?.length === 0 && (
            <p className="collection-empty">
              Empty. Right-click a file in My Drive and choose “Add to collection”.
            </p>
          )}

          <ul className="collection-items">
            {(items ?? []).map((item) => (
              <li key={item.id}>
                <FileIcon
                  name={item.name}
                  mimeType={item.mimeType}
                  isFolder={item.isFolder}
                  size={22}
                />

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
                  // Says "remove", not "delete": this takes the reference out of
                  // the collection and leaves the file exactly where it is.
                  title="Remove from this collection. The file itself is untouched."
                  onClick={() => void removeItem(item.id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </section>
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

      {renaming && (
        <NameDialog
          title="Rename collection"
          initialValue={renaming.name}
          confirmLabel="Rename"
          onSubmit={(name) => {
            void api(`/api/collections/${renaming.id}`, { method: 'PATCH', body: { name } }).then(
              () => {
                setRenaming(null);
                void load();
              },
            );
          }}
          onClose={() => setRenaming(null)}
        />
      )}
    </div>
  );
}
