import { useCallback, useEffect, useRef, useState } from 'react';
import type { OrbitFile } from '@orbit/shared-types';
import { DownloadIcon } from './ActionIcon.js';
import { FileIcon } from './FileIcon.js';
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
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${file.name}`}
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
        gridTemplateRows: 'auto 1fr auto',
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

      <div
        style={{
          minHeight: 0,
          display: 'grid',
          placeItems: 'center',
          overflow: 'auto',
        }}
      >
        <PreviewBody file={file} kind={kind} contentUrl={contentUrl} />
      </div>

      <footer style={{ display: 'flex', justifyContent: 'center', gap: 8 }}>
        <button
          type="button"
          className="clay-button"
          disabled={!previous}
          onClick={() => step(-1)}
          style={{ padding: '0.45rem 1.1rem', fontSize: 13, visibility: previewable.length > 1 ? 'visible' : 'hidden' }}
        >
          Previous
        </button>
        <button
          type="button"
          className="clay-button"
          disabled={!next}
          onClick={() => step(1)}
          style={{ padding: '0.45rem 1.1rem', fontSize: 13, visibility: previewable.length > 1 ? 'visible' : 'hidden' }}
        >
          Next
        </button>
      </footer>
    </div>
  );
}

const MEDIA_STYLE = {
  maxWidth: '100%',
  maxHeight: '100%',
  borderRadius: 'var(--radius-md)',
  display: 'block',
} as const;

function PreviewBody({
  file,
  kind,
  contentUrl,
}: {
  file: OrbitFile;
  kind: ReturnType<typeof previewKindFor>;
  contentUrl: Props['contentUrl'];
}) {
  const src = contentUrl(file, false);

  if (kind === 'image') {
    return <img src={src} alt={file.name} style={MEDIA_STYLE} />;
  }

  if (kind === 'video') {
    // Range requests are honoured by the content route, so seeking works
    // without pulling the whole file.
    return <video src={src} controls playsInline style={MEDIA_STYLE} />;
  }

  if (kind === 'audio') {
    return (
      <div className="clay" style={{ padding: '1.5rem', display: 'grid', gap: '1rem', placeItems: 'center' }}>
        <FileIcon name={file.name} mimeType={file.mimeType} isFolder={false} size={54} />
        <audio src={src} controls style={{ width: 'min(420px, 80vw)' }} />
      </div>
    );
  }

  if (kind === 'pdf') {
    return (
      <iframe
        src={src}
        title={file.name}
        style={{ width: '100%', height: '100%', minHeight: '60vh', border: 0, borderRadius: 'var(--radius-md)', background: '#fff' }}
      />
    );
  }

  if (kind === 'text') {
    return <TextPreview src={src} name={file.name} />;
  }

  return <NoPreview file={file} contentUrl={contentUrl} />;
}

function TextPreview({ src, name }: { src: string; name: string }) {
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

  return (
    <pre
      aria-label={`Contents of ${name}`}
      className="clay"
      style={{
        margin: 0,
        padding: '1rem 1.1rem',
        width: '100%',
        maxHeight: '100%',
        overflow: 'auto',
        fontSize: 13,
        lineHeight: 1.55,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {text}
    </pre>
  );
}

function NoPreview({ file, contentUrl }: { file: OrbitFile; contentUrl: Props['contentUrl'] }) {
  const isGoogleDoc = file.mimeType.startsWith('application/vnd.google-apps.');

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
      <a className="clay-button clay-button--accent" href={contentUrl(file, true)} style={{ textDecoration: 'none' }}>
        Download
      </a>
    </div>
  );
}
