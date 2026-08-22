import { useEffect, useState } from 'react';
import type { OrbitFile } from '@orbit/shared-types';
import { ApiError, api } from '../lib/api.js';
import { Modal } from './Modal.js';

/**
 * Putting a file into a collection.
 *
 * Says plainly that nothing moves. The word "add" reads like a copy, and this
 * is the moment someone decides whether to trust it with a file they care
 * about.
 */

interface Collection {
  id: string;
  name: string;
  itemCount: number;
}

export function AddToCollection({
  file,
  accountId,
  onClose,
}: {
  file: OrbitFile;
  accountId: string;
  onClose: () => void;
}) {
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [creating, setCreating] = useState('');
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<{ collections: Collection[] }>('/api/collections', { signal: controller.signal })
      .then(({ collections: rows }) => setCollections(rows))
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setCollections([]);
      });
    return () => controller.abort();
  }, []);

  async function add(collectionId: string): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      await api(`/api/collections/${collectionId}/items`, {
        method: 'POST',
        // The provider would need a request per ancestor to work this out.
        body: { accountId, remoteId: file.remoteId, virtualPath: file.virtualPath },
      });
      setAdded(collectionId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add it');
    } finally {
      setBusy(false);
    }
  }

  async function createThenAdd(): Promise<void> {
    if (!creating.trim()) return;
    setBusy(true);

    try {
      const { collection } = await api<{ collection: Collection }>('/api/collections', {
        method: 'POST',
        body: { name: creating.trim() },
      });
      setCreating('');
      setCollections((current) => [collection, ...(current ?? [])]);
      await add(collection.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create it');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Add ${file.name} to a collection`}
      description="A collection points at the file where it is. Nothing is moved, copied or uploaded."
      onClose={onClose}
    >
      <div style={{ display: 'grid', gap: '0.8rem' }}>
        {collections === null && <p style={{ color: 'var(--text-muted)', margin: 0 }}>Loading…</p>}

        {collections?.length === 0 && (
          <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: 13.5 }}>
            No collections yet. Name one below and this file goes straight into it.
          </p>
        )}

        <ul className="collection-picker">
          {(collections ?? []).map((collection) => (
            <li key={collection.id}>
              <button
                type="button"
                disabled={busy || added === collection.id}
                onClick={() => void add(collection.id)}
              >
                <span>{collection.name}</span>
                <span className="collection-picker__count">
                  {added === collection.id ? 'Added' : `${collection.itemCount}`}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="collection-picker__new">
          <input
            className="clay-sunken"
            placeholder="Or make a new one…"
            value={creating}
            onChange={(event) => setCreating(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void createThenAdd();
            }}
            style={{
              border: 0,
              padding: '0.6rem 0.9rem',
              font: 'inherit',
              fontSize: 14,
              color: 'var(--text)',
              borderRadius: 'var(--radius-sm)',
            }}
          />
          <button
            type="button"
            className="clay-button clay-button--accent"
            disabled={busy || !creating.trim()}
            onClick={() => void createThenAdd()}
          >
            Create and add
          </button>
        </div>

        {error && (
          <p role="alert" style={{ color: 'var(--danger)', margin: 0, fontSize: 13.5 }}>
            {error}
          </p>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className="clay-button" onClick={onClose}>
            {added ? 'Done' : 'Close'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
