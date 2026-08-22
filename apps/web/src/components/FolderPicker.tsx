import { useCallback, useEffect, useState } from 'react';
import type { OrbitFile } from '@orbit/shared-types';
import { ApiError, api } from '../lib/api.js';
import { FolderIcon } from './Icons.js';
import { Modal } from './Modal.js';

/**
 * Choosing a folder in the same drive, to move or copy something into.
 *
 * Browsing rather than typing a path: people know where a folder is by
 * recognising it, and a typed path is a spelling test with a 404 for a wrong
 * answer.
 *
 * Nothing leaves the provider. Inside one account every provider moves and
 * copies server-side, so this is a request or two rather than a download and a
 * re-upload of a file that never needed to travel.
 */

interface Props {
  file: OrbitFile;
  accountId: string;
  mode: 'copy' | 'move';
  /** Where the file is now, so the picker can refuse to put it back. */
  currentFolder: string;
  onClose: () => void;
  onDone: () => void;
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}

export function FolderPicker({ file, accountId, mode, currentFolder, onClose, onDone }: Props) {
  const [path, setPath] = useState('/');
  const [folders, setFolders] = useState<OrbitFile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (target: string, signal?: AbortSignal) => {
      setFolders(null);
      const query = new URLSearchParams({ accountId, path: target });

      const page = await api<{ files: OrbitFile[] }>(`/api/files?${query.toString()}`, { signal });
      setFolders(page.files.filter((entry) => entry.isFolder && entry.remoteId !== file.remoteId));
    },
    [accountId, file.remoteId],
  );

  useEffect(() => {
    const controller = new AbortController();

    load(path, controller.signal).catch((err: Error) => {
      if (err.name !== 'AbortError') setError('Could not open that folder');
    });

    return () => controller.abort();
  }, [load, path]);

  // Where it already is. Copying into it would make a duplicate beside itself
  // and moving into it would do nothing at all.
  const isCurrent = path === currentFolder;

  async function confirm(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      await api(`/api/files/${encodeURIComponent(file.remoteId)}/relocate`, {
        method: 'POST',
        body: { accountId, targetPath: path, copy: mode === 'copy' },
      });
      onDone();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 400
          ? 'This provider cannot move files between folders'
          : `Could not ${mode} it there`,
      );
      setBusy(false);
    }
  }

  const crumbs = ['/', ...path.split('/').filter(Boolean)];

  return (
    <Modal
      title={mode === 'copy' ? `Copy “${file.name}”` : `Move “${file.name}”`}
      onClose={onClose}
    >
      <div className="picker">
        <nav className="picker__crumbs" aria-label="Folder">
          {crumbs.map((segment, index) => {
            const to = index === 0 ? '/' : `/${crumbs.slice(1, index + 1).join('/')}`;

            return (
              <button
                key={to}
                type="button"
                disabled={to === path}
                onClick={() => setPath(to)}
              >
                {index === 0 ? 'Home' : segment}
              </button>
            );
          })}
        </nav>

        <ul className="picker__list">
          {path !== '/' && (
            <li>
              <button type="button" onClick={() => setPath(parentOf(path))}>
                <FolderIcon size={17} />
                <span>..</span>
              </button>
            </li>
          )}

          {folders === null && <li className="picker__note">Loading…</li>}

          {folders?.length === 0 && (
            <li className="picker__note">
              No folders in here. It can still be the destination.
            </li>
          )}

          {folders?.map((folder) => (
            <li key={folder.remoteId}>
              <button type="button" onClick={() => setPath(folder.virtualPath)}>
                <FolderIcon size={17} />
                <span>{folder.name}</span>
              </button>
            </li>
          ))}
        </ul>

        <p className="picker__target">
          {isCurrent ? (
            <>
              <strong>{file.name}</strong> is already here.
            </>
          ) : (
            <>
              {mode === 'copy' ? 'Copy' : 'Move'} to <strong>{path}</strong>
            </>
          )}
        </p>

        {error && (
          <p role="alert" style={{ color: 'var(--danger)', fontSize: 13, margin: 0 }}>
            {error}
          </p>
        )}

        <div className="picker__actions">
          <button type="button" className="clay-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="clay-button clay-button--accent"
            disabled={busy || isCurrent}
            onClick={() => void confirm()}
          >
            {busy ? 'Working…' : mode === 'copy' ? 'Copy here' : 'Move here'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
