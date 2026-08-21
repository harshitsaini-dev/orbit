import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Orbit's own PDF viewer.
 *
 * An `<iframe>` was doing this before, which meant the browser's viewer: a
 * different toolbar on every platform, none of them themeable, and - the part
 * that actually matters - a native password box for an encrypted file. This
 * renders the pages itself, so the toolbar is Orbit's and so is the password
 * prompt.
 *
 * pdf.js is loaded on demand. It is around a megabyte, and most files are not
 * PDFs; paying for it on every page load to save a moment on some of them is
 * the wrong way round.
 */

type PdfDocument = {
  numPages: number;
  getPage: (page: number) => Promise<PdfPage>;
  destroy: () => Promise<void>;
};

type PdfPage = {
  getViewport: (options: { scale: number }) => { width: number; height: number };
  render: (options: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }) => { promise: Promise<void>; cancel: () => void };
};

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/** Kept across mounts: the library is large and parsing it twice is wasted. */
let pdfjs: typeof import('pdfjs-dist') | null = null;

async function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (pdfjs) return pdfjs;

  const library = await import('pdfjs-dist');
  // Vite resolves this to a bundled asset URL; without it the worker is fetched
  // from a CDN, which the page's own policy forbids and which would put the
  // rendering of a private file through somebody else's server.
  library.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();

  pdfjs = library;
  return library;
}

export function PdfViewer({ src, name }: { src: string; name: string }) {
  const shellRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  /**
   * Bumped whenever this viewer is torn down or reopened. A load that finishes
   * after its generation has passed destroys what it opened and returns: under
   * StrictMode the effect runs, unmounts and runs again, and without this the
   * second render draws against a document the first one has already destroyed
   * - which surfaces as "Transport destroyed" and a blank page.
   */
  const generation = useRef(0);

  // In state rather than a ref, so that a document arriving re-runs the render.
  const [document_, setDocument] = useState<PdfDocument | null>(null);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState<number | null>(null); // null means fit to width
  const [fullscreen, setFullscreen] = useState(false);
  const [status, setStatus] = useState<'loading' | 'password' | 'ready' | 'failed'>('loading');
  const [password, setPassword] = useState('');
  const [passwordWrong, setPasswordWrong] = useState(false);
  const [width, setWidth] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(
    async (withPassword?: string) => {
      generation.current += 1;
      const mine = generation.current;

      setStatus('loading');
      setError(null);

      try {
        const library = await loadPdfjs();
        const task = library.getDocument({
          url: src,
          withCredentials: true,
          ...(withPassword ? { password: withPassword } : {}),
        });

        const opened = (await task.promise) as unknown as PdfDocument;

        if (mine !== generation.current) {
          void opened.destroy().catch(() => undefined);
          return;
        }

        setDocument((previous) => {
          void previous?.destroy().catch(() => undefined);
          return opened;
        });
        setPages(opened.numPages);
        setPage(1);
        setStatus('ready');
      } catch (err) {
        if (mine !== generation.current) return;

        const code = (err as { name?: string }).name;

        // The document is encrypted, or the password just tried was wrong.
        // Either way the answer is the same prompt, and only the second says so.
        if (code === 'PasswordException') {
          setPasswordWrong(withPassword !== undefined);
          setStatus('password');
          return;
        }

        setError(
          code === 'InvalidPDFException'
            ? 'This file is not a readable PDF.'
            : 'Could not open this PDF.',
        );
        setStatus('failed');
      }
    },
    [src],
  );

  useEffect(() => {
    void open();
    return () => {
      generation.current += 1;
    };
  }, [open]);

  // Separate from the load: the document is destroyed when it is replaced or
  // when the viewer goes away for good, never as part of a re-run.
  useEffect(() => {
    return () => {
      void document_?.destroy().catch(() => undefined);
    };
  }, [document_]);

  // Draw whenever the page, the zoom or the available width changes.
  useEffect(() => {
    if (status !== 'ready') return;

    let cancelled = false;
    let task: { promise: Promise<void>; cancel: () => void } | null = null;

    void (async () => {
      const canvas = canvasRef.current;
      if (!document_ || !canvas) return;

      const rendered = await document_.getPage(page);
      if (cancelled) return;

      const natural = rendered.getViewport({ scale: 1 });
      const available = (canvas.parentElement?.clientWidth ?? natural.width) - 24;
      const scale = zoom ?? Math.max(0.1, available / natural.width);

      // Draw at the device's real pixel density: a canvas scaled up by CSS is
      // a blurry page, which is the whole thing a document viewer must not be.
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = rendered.getViewport({ scale: scale * ratio });

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
      canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;

      const context = canvas.getContext('2d');
      if (!context) return;

      task = rendered.render({ canvasContext: context, viewport });
      await task.promise.catch(() => undefined);
    })();

    return () => {
      cancelled = true;
      // Abandoning a render that is still running leaves the canvas half drawn
      // and the worker busy on a page nobody is looking at.
      task?.cancel();
    };
  }, [page, zoom, status, document_, width]);

  // Fit-to-width has to mean the width it currently is, not the width it was
  // when the file opened - entering fullscreen changes it by a lot.
  useEffect(() => {
    const host = canvasRef.current?.parentElement;
    if (!host) return;

    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [status]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    if (status !== 'ready') return;

    function onKey(event: KeyboardEvent) {
      if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        setPage((current) => Math.min(current + 1, pages));
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        setPage((current) => Math.max(current - 1, 1));
      } else {
        return;
      }
      event.preventDefault();
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pages, status]);

  if (status === 'password') {
    return (
      <PasswordPrompt
        name={name}
        wrong={passwordWrong}
        value={password}
        onChange={setPassword}
        onSubmit={() => void open(password)}
      />
    );
  }

  if (status === 'failed') {
    return (
      <div className="pdf-shell pdf-shell--message">
        <p style={{ color: 'var(--danger)', margin: 0 }}>{error}</p>
      </div>
    );
  }

  const zoomIndex = zoom === null ? -1 : ZOOMS.indexOf(zoom);

  return (
    <div ref={shellRef} className={fullscreen ? 'pdf-shell pdf-shell--fullscreen' : 'pdf-shell'}>
      <div className="pdf-shell__page">
        {status === 'loading' && <span className="pdf-shell__loading">Opening…</span>}
        <canvas ref={canvasRef} aria-label={`Page ${page} of ${name}`} />
      </div>

      <div className="pdf-shell__bar">
        <div className="scrim-bar">
          <button
            type="button"
            className="clay-button"
            onClick={() => setPage((current) => Math.max(current - 1, 1))}
            disabled={page <= 1}
            aria-label="Previous page"
          >
            ‹
          </button>

          <span className="pdf-shell__count">
            {page} / {pages || '…'}
          </span>

          <button
            type="button"
            className="clay-button"
            onClick={() => setPage((current) => Math.min(current + 1, pages))}
            disabled={page >= pages}
            aria-label="Next page"
          >
            ›
          </button>

          <span className="pdf-shell__divider" />

          <button
            type="button"
            className="clay-button"
            onClick={() =>
              setZoom((current) => {
                const index = current === null ? 2 : ZOOMS.indexOf(current);
                return ZOOMS[Math.max(0, index - 1)] ?? ZOOMS[0]!;
              })
            }
            aria-label="Zoom out"
          >
            −
          </button>

          <button
            type="button"
            className="clay-button"
            onClick={() => setZoom(null)}
            aria-pressed={zoom === null}
            title="Fit to width"
          >
            {zoom === null ? 'Fit' : `${Math.round(zoom * 100)}%`}
          </button>

          <button
            type="button"
            className="clay-button"
            onClick={() =>
              setZoom((current) => {
                const index = current === null ? 2 : zoomIndex;
                return ZOOMS[Math.min(ZOOMS.length - 1, index + 1)] ?? ZOOMS.at(-1)!;
              })
            }
            aria-label="Zoom in"
          >
            +
          </button>

          <span className="pdf-shell__divider" />

          <button
            type="button"
            className="clay-button"
            onClick={() => {
              if (document.fullscreenElement) void document.exitFullscreen();
              else void shellRef.current?.requestFullscreen();
            }}
            aria-label={fullscreen ? 'Leave fullscreen' : 'Fullscreen'}
          >
            <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block' }}>
              {fullscreen ? (
                <path d="M9.5 4.5v5h-5M14.5 19.5v-5h5M14.5 4.5v5h5M9.5 19.5v-5h-5" />
              ) : (
                <path d="M4.5 9.5v-5h5M19.5 14.5v5h-5M19.5 9.5v-5h-5M4.5 14.5v5h5" />
              )}
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The prompt for an encrypted PDF.
 *
 * In its own component and its own state so that a wrong password re-asks
 * inline. The browser's own box would have been a native dialog Orbit cannot
 * style, cannot explain, and cannot show a second time with "that was wrong".
 */
function PasswordPrompt({
  name,
  wrong,
  value,
  onChange,
  onSubmit,
}: {
  name: string;
  wrong: boolean;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [wrong]);

  return (
    <div className="pdf-shell pdf-shell--message">
      <form
        className="clay pdf-password"
        onSubmit={(event) => {
          event.preventDefault();
          if (value) onSubmit();
        }}
      >
        <span className="pdf-password__glyph" aria-hidden="true">
          <svg viewBox="0 0 24 24" width={26} height={26} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
            <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.2" />
            <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
          </svg>
        </span>

        <h2>This PDF is password protected</h2>
        <p>
          {name} is encrypted. Orbit needs the password to render it — it is used here in the
          browser and never sent anywhere.
        </p>

        <input
          ref={inputRef}
          type="password"
          className="clay-sunken"
          placeholder="Password"
          autoComplete="off"
          aria-label="PDF password"
          aria-invalid={wrong}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />

        {wrong && (
          <p role="alert" className="pdf-password__error">
            That password did not open it. Try again.
          </p>
        )}

        <button type="submit" className="clay-button clay-button--accent" disabled={!value}>
          Unlock
        </button>
      </form>
    </div>
  );
}
