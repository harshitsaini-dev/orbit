import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { OrbitFile } from '@orbit/shared-types';
import { FileViewer } from './components/FilePreview.js';
import { BrandMark } from './components/BrandMark.js';
import { FileIcon } from './components/FileIcon.js';
import { formatBytes } from './lib/format.js';
import './styles/global.css';

/**
 * The share page's viewer.
 *
 * A separate entry rather than a route in the application: this page is served
 * by the API, from the same origin as the bytes, and it has to work for a
 * stranger with no session. What it renders, though, is the workspace's own
 * viewer - the same components, so a shared PDF, spreadsheet or archive opens
 * the way the owner sees it rather than as a download button.
 *
 * The server has already rendered a page that works without any of this. This
 * replaces it when it loads, and its absence costs the visitor the richer
 * formats rather than the file.
 */

interface ShareData {
  shortId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  permission: 'view' | 'download';
  expiresAt?: string | null;
}

function readData(): ShareData | null {
  const script = document.getElementById('share-data');
  if (!script?.textContent) return null;

  try {
    return JSON.parse(script.textContent) as ShareData;
  } catch {
    return null;
  }
}

function SharePage({ data }: { data: ShareData }) {
  /*
   * A share is one file with no folder around it, so the parts of OrbitFile
   * that describe where something sits are filled in rather than fetched. The
   * viewer only reads the name, the type and the size.
   */
  const file: OrbitFile = {
    remoteId: data.shortId,
    name: data.name,
    virtualPath: `/${data.name}`,
    mimeType: data.mimeType,
    sizeBytes: data.sizeBytes,
    isFolder: false,
    starred: false,
    modifiedAt: new Date(0).toISOString(),
  };

  // Everything is served through the share's own content route, so the
  // provider's URL never reaches the browser here either.
  const contentUrl = (_target: OrbitFile, download: boolean): string =>
    `/s/${encodeURIComponent(data.shortId)}/content${download ? '?download' : ''}`;

  return (
    <div className="share-page">
      <header className="clay share-head">
        <FileIcon name={data.name} mimeType={data.mimeType} isFolder={false} size={26} />

        <div style={{ display: 'grid', gap: 2, minWidth: 0, flex: 1 }}>
          <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {data.name}
          </strong>
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            {formatBytes(data.sizeBytes)}
            {data.expiresAt && ` · link expires ${data.expiresAt.slice(0, 10)}`}
          </span>
        </div>

        {data.permission === 'download' && (
          <a
            className="clay-button clay-button--accent"
            href={contentUrl(file, true)}
            download={data.name}
            style={{ padding: '0.45rem 1.1rem', fontSize: 13, textDecoration: 'none' }}
          >
            Download
          </a>
        )}
      </header>

      <div className="preview-stage">
        <FileViewer file={file} contentUrl={contentUrl} />
      </div>

      {/* The mark, so the page a stranger opens is visibly from somewhere -
          the same one the tab icon and the fallback page use. */}
      <footer
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 7,
          color: 'var(--text-muted)',
          fontSize: 12.5,
        }}
      >
        <BrandMark size={16} />
        Shared through Orbit. The file stays in its owner&apos;s own cloud storage.
      </footer>
    </div>
  );
}

const container = document.getElementById('share-root');
const data = readData();

// Without either, the server-rendered page stays exactly as it is, which is
// the better outcome than an empty screen.
if (container && data) {
  createRoot(container).render(
    <StrictMode>
      <SharePage data={data} />
    </StrictMode>,
  );
}
