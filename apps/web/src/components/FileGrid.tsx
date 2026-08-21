import { useEffect, useRef, useState } from 'react';
import type { OrbitFile } from '@orbit/shared-types';
import { Checkbox } from './Checkbox.js';
import { FileIcon } from './FileIcon.js';
import { formatBytes } from '../lib/format.js';
import { fetchThumbnail } from '../lib/thumbnails.js';

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
}: {
  files: OrbitFile[];
  accountIdFor: (file: OrbitFile) => string;
  selected: Set<string>;
  onToggleSelect: (remoteId: string) => void;
  onOpen: (file: OrbitFile) => void;
  showLocation?: boolean;
  locationOf?: (file: OrbitFile) => string;
}) {
  return (
    <ul
      data-testid="file-grid"
      style={{
        listStyle: 'none',
        padding: 0,
        margin: 0,
        display: 'grid',
        gap: 12,
        gridTemplateColumns: 'repeat(auto-fill, minmax(clamp(130px, 22vw, 168px), 1fr))',
      }}
    >
      {files.map((file) => (
        <li key={file.remoteId}>
          <Tile
            file={file}
            accountId={accountIdFor(file)}
            selected={selected.has(file.remoteId)}
            onToggleSelect={() => onToggleSelect(file.remoteId)}
            onOpen={() => onOpen(file)}
            location={showLocation ? locationOf?.(file) : undefined}
          />
        </li>
      ))}
    </ul>
  );
}

function Tile({
  file,
  accountId,
  selected,
  onToggleSelect,
  onOpen,
  location,
}: {
  file: OrbitFile;
  accountId: string;
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  location?: string;
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

  return (
    <div
      ref={ref}
      className="clay-sunken file-tile"
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
        onClick={onOpen}
        title={file.name}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'grid',
          gap: 8,
          minWidth: 0,
        }}
      >
        <span
          style={{
            aspectRatio: '1 / 1',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--surface)',
            display: 'grid',
            placeItems: 'center',
            overflow: 'hidden',
          }}
        >
          {file.isFolder || !near ? (
            <FileIcon name={file.name} mimeType={file.mimeType} isFolder={file.isFolder} size={44} />
          ) : (
            <Thumbnail file={file} accountId={accountId} />
          )}
        </span>

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
              fontSize: 11,
              color: 'var(--text-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {location ?? (file.isFolder ? 'Folder' : formatBytes(file.sizeBytes))}
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
