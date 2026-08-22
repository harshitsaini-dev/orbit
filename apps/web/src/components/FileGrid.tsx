import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { OrbitFile } from '@orbit/shared-types';
import { Checkbox } from './Checkbox.js';
import { FileIcon } from './FileIcon.js';
import { ShareIcon } from './ActionIcon.js';
import { formatBytes } from '../lib/format.js';
import { fetchThumbnail, mightHaveThumbnail } from '../lib/thumbnails.js';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

/**
 * Tiles with a real preview where the provider has one.
 *
 * Thumbnails load only once a tile is near the viewport. A folder of two
 * hundred photos would otherwise fire two hundred requests at the provider the
 * moment the page opened, and rate-limit the account for the sake of images
 * nobody has scrolled to.
 */
export function FileGrid({
  files,
  accountIdFor,
  selected,
  onToggleSelect,
  onOpen,
  showLocation,
  locationOf,
  onContextMenu,
  selectionKey,
}: {
  files: OrbitFile[];
  accountIdFor: (file: OrbitFile) => string;
  selected: Set<string>;
  onToggleSelect: (remoteId: string) => void;
  /**
   * How a file is keyed in the selection.
   *
   * Defaults to the remote id, which is unique inside one drive - and wrong
   * anywhere that spans several. The bin does, and used to look as though
   * selecting did nothing: the click registered against the account-qualified
   * key the page keeps and the tile went on comparing against a bare remote id
   * that was never in the set.
   */
  selectionKey?: (file: OrbitFile) => string;
  /**
   * Opening a tile - and the event that did it, because a click holding shift
   * or ctrl means "select", not "open", and only the caller keeps the
   * selection to act on.
   */
  onOpen: (file: OrbitFile, event: React.MouseEvent) => void;
  showLocation?: boolean;
  /**
   * What to say under the name instead of the size.
   *
   * A node rather than a string, so a page whose files span several drives can
   * show which one - a nickname on its own does not say whether that is a
   * Google Drive or a bucket, and on the pages that need this at all it is
   * usually the first thing somebody wants to know.
   */
  locationOf?: (file: OrbitFile) => ReactNode;
  onContextMenu?: (event: React.MouseEvent, file: OrbitFile) => void;
}) {
  /*
   * Folders and files are laid out separately.
   *
   * They are different heights - a folder is a row, a file is a card with a
   * preview - and in one grid a row that mixes them takes the height of the
   * tallest, leaving the folders in it floating over a hole. Two grids, each
   * of one kind, and every row is the height it should be.
   */
  const folders = files.filter((file) => file.isFolder);
  const rest = files.filter((file) => !file.isFolder);

  const tile = (file: OrbitFile) => (
    <li
      key={selectionKey ? selectionKey(file) : file.remoteId}
      {...(onContextMenu ? { onContextMenu: (event) => onContextMenu(event, file) } : {})}
    >
      <Tile
        file={file}
        accountId={accountIdFor(file)}
        selectionKey={selectionKey ? selectionKey(file) : file.remoteId}
        selected={selected.has(selectionKey ? selectionKey(file) : file.remoteId)}
        onToggleSelect={() => onToggleSelect(file.remoteId)}
        onOpen={(event) => onOpen(file, event)}
        location={showLocation ? locationOf?.(file) : undefined}
      />
    </li>
  );

  return (
    <div data-testid="file-grid" className="file-grid">
      {folders.length > 0 && (
        <>
          {/* Named only when there is something else to tell them apart from. */}
          {rest.length > 0 && <h2 className="file-grid__heading">Folders</h2>}
          <ul className="file-grid__list file-grid__list--folders">{folders.map(tile)}</ul>
        </>
      )}

      {rest.length > 0 && (
        <>
          {folders.length > 0 && <h2 className="file-grid__heading">Files</h2>}
          <ul className="file-grid__list">{rest.map(tile)}</ul>
        </>
      )}
    </div>
  );
}

function Tile({
  file,
  accountId,
  selectionKey,
  selected,
  onToggleSelect,
  onOpen,
  location,
}: {
  file: OrbitFile;
  accountId: string;
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: (event: React.MouseEvent) => void;
  location?: ReactNode;
  /** What a drag-select box matches this tile by. */
  selectionKey: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || file.isFolder) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // Kept live rather than disconnected on first sight: a tile that
        // scrolls back out should release its place in the fetch queue.
        setNear(entries.some((entry) => entry.isIntersecting));
      },
      // A margin, so a tile is fetched just before it is scrolled into view.
      { rootMargin: '220px' },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [file.isFolder]);

  /*
   * A folder has no preview to show, so it does not get the square kept for
   * one. It used to: a 44px icon centred in a 160px empty box, repeated for
   * every folder in the drive - and most drives are mostly folders, so a grid
   * of them was mostly nothing. Compact, they read as a block of folders above
   * the files, which is the shape people already expect from a file manager.
   */
  const compact = file.isFolder;

  return (
    <div
      ref={ref}
      className={`clay-sunken file-tile${compact ? ' file-tile--folder' : ''}`}
      // What a drag-select box looks for. Also what marks a tile as "not empty
      // space", so a drag cannot start on top of one.
      data-file={selectionKey}
      data-selected={selected ? '' : undefined}
      style={{ padding: 8, display: 'grid', gap: 8, position: 'relative' }}
    >
      <span
        className="file-tile__select"
        data-visible={selected ? '' : undefined}
        style={{ position: 'absolute', top: 12, left: 12, zIndex: 2 }}
      >
        <Checkbox checked={selected} onChange={onToggleSelect} aria-label={`Select ${file.name}`} size={20} />
      </span>

      <button
        type="button"
        onClick={(event) => onOpen(event)}
        title={file.name}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: compact ? 'flex' : 'grid',
          alignItems: 'center',
          gap: 8,
          minWidth: 0,
        }}
      >
        {compact ? (
          <span style={{ position: 'relative', display: 'grid', placeItems: 'center', flex: 'none' }}>
            <FileIcon name={file.name} mimeType={file.mimeType} isFolder size={26} />
            {file.shared && (
              <span className="shared-badge" title="Anyone with the link can open this">
                <ShareIcon />
              </span>
            )}
          </span>
        ) : (
          <span
            style={{
              position: 'relative',
              aspectRatio: '1 / 1',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--surface)',
              display: 'grid',
              placeItems: 'center',
              overflow: 'hidden',
            }}
          >
            {!near || !mightHaveThumbnail(file) ? (
              <FileIcon name={file.name} mimeType={file.mimeType} isFolder={file.isFolder} size={44} />
            ) : (
              <Thumbnail file={file} accountId={accountId} />
            )}

            {/* A file anyone with the link can open is worth seeing at a glance,
                without opening anything. */}
            {file.shared && (
              <span className="shared-badge" title="Anyone with the link can open this">
                <ShareIcon />
              </span>
            )}
          </span>
        )}

        <span style={{ display: 'grid', gap: 1, minWidth: 0 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {file.name}
          </span>
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              color: 'var(--text-muted)',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {location ?? (file.isFolder ? '' : formatBytes(file.sizeBytes))}
          </span>
        </span>
      </button>
    </div>
  );
}

/**
 * Falls back to the type icon: a missing preview is normal, not an error.
 *
 * Fetched through the shared queue rather than by setting `<img src>` directly,
 * so a fast scroll cannot start hundreds of requests at once and starve
 * everything else on the connection.
 */
function Thumbnail({ file, accountId }: { file: OrbitFile; accountId: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let created: string | null = null;

    setFailed(false);
    setBlobUrl(null);

    const url = `${API_BASE}/api/files/${encodeURIComponent(file.remoteId)}/thumbnail?accountId=${encodeURIComponent(accountId)}&size=400`;

    fetchThumbnail(url, controller.signal)
      .then((objectUrl) => {
        created = objectUrl;
        setBlobUrl(objectUrl);
      })
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setFailed(true);
      });

    return () => {
      controller.abort();
      // Object URLs are held until revoked; a folder of photos would otherwise
      // leak one per tile for as long as the tab is open.
      if (created) URL.revokeObjectURL(created);
    };
  }, [accountId, file.remoteId]);

  if (failed || !blobUrl) {
    return <FileIcon name={file.name} mimeType={file.mimeType} isFolder={false} size={44} />;
  }

  return (
    <img
      src={blobUrl}
      alt=""
      decoding="async"
      style={{
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        gridArea: '1 / 1',
        animation: 'thumb-in var(--dur-base) var(--ease-clay)',
      }}
    />
  );
}
