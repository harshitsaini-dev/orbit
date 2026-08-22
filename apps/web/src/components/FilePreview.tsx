import { useCallback, useEffect, useRef, useState } from 'react';
import type { OrbitFile } from '@orbit/shared-types';
import { DownloadIcon } from './ActionIcon.js';
import { ArchiveViewer } from './ArchiveViewer.js';
import { CodeViewer } from './CodeViewer.js';
import { FontViewer } from './FontViewer.js';
import { MarkdownViewer } from './MarkdownViewer.js';
import { OfficeViewer } from './OfficeViewer.js';
import { CsvViewer } from './CsvViewer.js';
import { FileIcon } from './FileIcon.js';
import { ImageViewer } from './ImageViewer.js';
import { MediaPlayer } from './MediaPlayer.js';
import { ModelViewer } from './ModelViewer.js';
import { HexViewer } from './HexViewer.js';
import { PdfViewer } from './PdfViewer.js';
import { formatBytes } from '../lib/format.js';
import { previewKindFor, TEXT_PREVIEW_LIMIT } from '../lib/preview.js';

interface Props {
  file: OrbitFile;
  /** Same-folder siblings, so the viewer can step through them. */
  siblings: OrbitFile[];
  contentUrl: (file: OrbitFile, download: boolean) => string;
  onSelect: (file: OrbitFile) => void;
  onClose: () => void;
}

/**
 * Orbit's own viewer. Everything is served through `/api/files/:id/content`,
 * so the provider's URL never reaches the browser — which is the whole reason
 * files are not simply opened in a new tab.
 */
export function FilePreview({ file, siblings, contentUrl, onSelect, onClose }: Props) {
  const kind = previewKindFor(file);
  const dialogRef = useRef<HTMLDivElement>(null);

  const previewable = siblings.filter((sibling) => !sibling.isFolder);
  const index = previewable.findIndex((sibling) => sibling.remoteId === file.remoteId);
  const previous = index > 0 ? previewable[index - 1] : undefined;
  const next = index >= 0 && index < previewable.length - 1 ? previewable[index + 1] : undefined;

  const step = useCallback(
    (direction: -1 | 1) => {
      const target = direction === -1 ? previous : next;
      if (target) onSelect(target);
    },
    [previous, next, onSelect],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft') step(-1);
      if (event.key === 'ArrowRight') step(1);
    }

    document.addEventListener('keydown', onKey);
    // The page behind must not scroll while the viewer is open.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, step]);

  return (
    /* The backdrop click closes it; Escape does the same and the dialog takes
       focus, so a keyboard user is never dependent on this. */
    /* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${file.name}`}
      // The viewer arrives the way every other overlay does.
      className="modal-scrim"
      data-testid="file-preview"
      ref={dialogRef}
      tabIndex={-1}
      onClick={(event) => {
        // Only a click on the backdrop itself closes; clicks inside do not.
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        background: 'rgba(8, 10, 16, 0.72)',
        backdropFilter: 'blur(6px)',
        display: 'grid',
        // minmax(0, ...) rather than a bare 1fr: a grid track's automatic
        // minimum is its content, so a tall video grew the row instead of being
        // bounded by it and ran off the bottom of the window.
        gridTemplateRows: 'auto minmax(0, 1fr) auto',
        gap: '0.75rem',
        padding: 'clamp(0.6rem, 2vw, 1.5rem)',
      }}
    >
      <header
        className="clay"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0.7rem 0.9rem',
          minWidth: 0,
        }}
      >
        <FileIcon name={file.name} mimeType={file.mimeType} isFolder={false} size={26} />

        <div style={{ display: 'grid', gap: 2, minWidth: 0, flex: 1 }}>
          <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {file.name}
          </strong>
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            {formatBytes(file.sizeBytes)}
            {previewable.length > 1 && index >= 0 && ` · ${index + 1} of ${previewable.length}`}
          </span>
        </div>

        <a
          className="clay-button"
          href={contentUrl(file, true)}
          aria-label={`Download ${file.name}`}
          style={{ padding: '0.4rem 0.7rem', display: 'grid', placeItems: 'center', textDecoration: 'none' }}
        >
          <DownloadIcon size={17} />
        </a>

        <button
          type="button"
          className="clay-button"
          onClick={onClose}
          aria-label="Close preview"
          style={{ padding: '0.4rem 0.9rem', fontSize: 13 }}
        >
          Close
        </button>
      </header>

      <div className="preview-stage">
        <FileViewer file={file} kind={kind} contentUrl={contentUrl} />
      </div>

      <footer style={{ display: 'flex', justifyContent: 'center' }}>
        {previewable.length > 1 && (
          <div className="scrim-bar">
            <button
              type="button"
              className="clay-button"
              disabled={!previous}
              onClick={() => step(-1)}
              style={{ padding: '0.45rem 1.1rem', fontSize: 13 }}
            >
              Previous
            </button>
            <button
              type="button"
              className="clay-button"
              disabled={!next}
              onClick={() => step(1)}
              style={{ padding: '0.45rem 1.1rem', fontSize: 13 }}
            >
              Next
            </button>
          </div>
        )}
      </footer>
    </div>
  );
}

/**
 * The viewer itself, without the dialog around it.
 *
 * Exported because the share page renders the same thing: somebody opening a
 * link should see the file the way its owner does, and two implementations of
 * that would drift the moment either gained a format.
 */
export function FileViewer({
  file,
  kind = previewKindFor(file),
  contentUrl,
}: {
  file: OrbitFile;
  kind?: ReturnType<typeof previewKindFor>;
  contentUrl: Props['contentUrl'];
}) {
  const src = contentUrl(file, false);

  if (kind === 'image') {
    return <ImageViewer src={src} alt={file.name} />;
  }

  if (kind === 'video' || kind === 'audio') {
    // Seeking works because the content route honours Range; without it the
    // scrubber would stall while the whole file downloaded.
    return <MediaPlayer src={src} kind={kind} name={file.name} mimeType={file.mimeType} />;
  }

  if (kind === 'pdf') {
    return <PdfViewer src={src} name={file.name} />;
  }

  if (kind === 'spreadsheet' || kind === 'document' || kind === 'presentation') {
    return <OfficeViewer src={src} name={file.name} kind={kind} />;
  }

  if (kind === 'archive') {
    return <ArchiveViewer src={src} name={file.name} mimeType={file.mimeType} sizeBytes={file.sizeBytes} />;
  }

  if (kind === 'font') {
    return <FontViewer src={src} name={file.name} />;
  }

  if (kind === 'model') {
    return <ModelViewer src={src} name={file.name} sizeBytes={file.sizeBytes} />;
  }

  if (kind === 'markdown') {
    return <TextPreview src={src} name={file.name} markdown />;
  }

  if (kind === 'text') {
    return <TextPreview src={src} name={file.name} />;
  }


  return <NoPreview file={file} contentUrl={contentUrl} />;
}

/**
 * The document itself is rendered by the browser's own PDF viewer, which cannot
 * be restyled — but it can be given the whole screen, which is the thing people
 * actually want from a document preview.
 */
function TextPreview({ src, name, markdown = false }: { src: string; name: string; markdown?: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setText(null);
    setError(null);

    fetch(src, { credentials: 'include', signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.text();
        // A file that lies about being text would otherwise lock the tab up.
        setText(body.length > TEXT_PREVIEW_LIMIT ? body.slice(0, TEXT_PREVIEW_LIMIT) : body);
      })
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setError('Could not load this file.');
      });

    return () => controller.abort();
  }, [src]);

  if (error) return <p style={{ color: 'var(--danger)' }}>{error}</p>;
  if (text === null) return <p style={{ color: 'var(--text-muted)' }}>Loading…</p>;

  // A spreadsheet export read as source is a wall of commas; the point of the
  // file is its columns.
  if (markdown) return <MarkdownViewer text={text} name={name} />;

  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (extension === 'csv' || extension === 'tsv') return <CsvViewer text={text} name={name} />;

  return <CodeViewer text={text} name={name} />;
}

function NoPreview({ file, contentUrl }: { file: OrbitFile; contentUrl: Props['contentUrl'] }) {
  const isGoogleDoc = file.mimeType.startsWith('application/vnd.google-apps.');
  const [bytes, setBytes] = useState(false);

  /*
   * Google's own formats hold no bytes of their own - the content route asks
   * Drive to export one - so there is nothing to inspect, and offering it would
   * show the export rather than the file.
   */
  if (bytes && !isGoogleDoc) {
    return <HexViewer src={contentUrl(file, false)} name={file.name} sizeBytes={file.sizeBytes} />;
  }

  return (
    <div
      className="clay"
      style={{ padding: 'clamp(1.5rem, 5vw, 2.5rem)', display: 'grid', gap: '0.9rem', placeItems: 'center', textAlign: 'center', maxWidth: 460 }}
    >
      <FileIcon name={file.name} mimeType={file.mimeType} isFolder={false} size={56} />
      <strong>No preview for this type</strong>
      <p style={{ color: 'var(--text-muted)', fontSize: 14, margin: 0 }}>
        {isGoogleDoc
          ? 'Google documents are converted to an Office format on download, which no browser renders inline.'
          : `${file.mimeType || 'This file type'} cannot be shown in the browser.`}
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        <a className="clay-button clay-button--accent" href={contentUrl(file, true)} style={{ textDecoration: 'none' }}>
          Download
        </a>

        {/* The bytes answer "what actually is this?" for a file whose name and
            type disagree, which is most of what reaches this screen. */}
        {!isGoogleDoc && file.sizeBytes > 0 && (
          <button type="button" className="clay-button" onClick={() => setBytes(true)}>
            Show bytes
          </button>
        )}
      </div>
    </div>
  );
}
