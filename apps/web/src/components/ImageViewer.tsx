import { useCallback, useEffect, useRef, useState } from 'react';

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];
const MIN_ZOOM = ZOOM_STEPS[0]!;
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;

/**
 * An image that fits the window first and zooms on request.
 *
 * "Fit" is a mode rather than a number: the image stays fitted as the window
 * resizes, and only becomes a fixed percentage once the user zooms. Panning is
 * enabled exactly when the image is larger than the frame, so a fitted image
 * cannot be dragged around pointlessly.
 */
export function ImageViewer({ src, alt }: { src: string; alt: string }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null);

  /** null means "fit"; a number is an explicit scale. */
  const [zoom, setZoom] = useState<number | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);

  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;

    const observer = new ResizeObserver(([entry]) => {
      if (entry) setFrame({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // A new image starts fitted, whatever the last one was left at.
  useEffect(() => {
    setZoom(null);
    setOffset({ x: 0, y: 0 });
    setNatural(null);
  }, [src]);

  const fitScale =
    natural && frame && natural.width > 0 && natural.height > 0
      ? Math.min(frame.width / natural.width, frame.height / natural.height, 1)
      : 1;

  const scale = zoom ?? fitScale;

  const setZoomAround = useCallback(
    (next: number) => {
      const clamped = Math.min(Math.max(next, MIN_ZOOM), MAX_ZOOM);
      setZoom(clamped);
      // Recentre when the image no longer overflows, so it cannot be left
      // stranded off-screen after zooming back out.
      if (natural && frame && natural.width * clamped <= frame.width && natural.height * clamped <= frame.height) {
        setOffset({ x: 0, y: 0 });
      }
    },
    [frame, natural],
  );

  const zoomIn = useCallback(() => {
    setZoomAround(ZOOM_STEPS.find((step) => step > scale + 0.001) ?? MAX_ZOOM);
  }, [scale, setZoomAround]);

  const zoomOut = useCallback(() => {
    setZoomAround([...ZOOM_STEPS].reverse().find((step) => step < scale - 0.001) ?? MIN_ZOOM);
  }, [scale, setZoomAround]);

  const fit = useCallback(() => {
    setZoom(null);
    setOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomIn();
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        zoomOut();
      } else if (event.key === '0') {
        event.preventDefault();
        fit();
      }
    }

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [zoomIn, zoomOut, fit]);

  const overflows =
    natural !== null &&
    frame !== null &&
    (natural.width * scale > frame.width + 1 || natural.height * scale > frame.height + 1);

  function onWheel(event: React.WheelEvent) {
    // Only with a modifier: a bare wheel should scroll the page, not zoom.
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    if (event.deltaY < 0) zoomIn();
    else zoomOut();
  }

  function onPointerDown(event: React.PointerEvent) {
    if (!overflows) return;
    (event.target as Element).setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, startX: offset.x, startY: offset.y };
  }

  function onPointerMove(event: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    setOffset({
      x: drag.startX + (event.clientX - drag.x),
      y: drag.startY + (event.clientY - drag.y),
    });
  }

  function endDrag(event: React.PointerEvent) {
    if (!dragRef.current) return;
    (event.target as Element).releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
  }

  return (
    <div style={{ display: 'grid', gridTemplateRows: '1fr auto', gap: 10, minHeight: 0, height: '100%', width: '100%' }}>
      <div
        ref={frameRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
          minHeight: 0,
          overflow: 'hidden',
          display: 'grid',
          placeItems: 'center',
          cursor: overflows ? (dragRef.current ? 'grabbing' : 'grab') : 'default',
          touchAction: overflows ? 'none' : 'auto',
        }}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(event) =>
            setNatural({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          style={{
            // Sized explicitly rather than with max-width: a percentage inside a
            // grid track does not constrain reliably, which is what let a large
            // photo overflow the window instead of fitting it.
            width: natural ? natural.width * scale : 'auto',
            height: natural ? natural.height * scale : 'auto',
            maxWidth: 'none',
            transform: `translate(${offset.x}px, ${offset.y}px)`,
            borderRadius: 'var(--radius-md)',
            display: 'block',
            userSelect: 'none',
          }}
        />
      </div>

      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <div className="scrim-bar">
        <button
          type="button"
          className="clay-button"
          onClick={zoomOut}
          disabled={scale <= MIN_ZOOM + 0.001}
          aria-label="Zoom out"
          style={BUTTON}
        >
          −
        </button>

        <span
          style={{ minWidth: 58, textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' }}
          aria-live="polite"
        >
          {Math.round(scale * 100)}%
        </span>

        <button
          type="button"
          className="clay-button"
          onClick={zoomIn}
          disabled={scale >= MAX_ZOOM - 0.001}
          aria-label="Zoom in"
          style={BUTTON}
        >
          +
        </button>

        <button
          type="button"
          className="clay-button"
          onClick={fit}
          aria-pressed={zoom === null}
          style={{ ...BUTTON, padding: '0.35rem 0.9rem', width: 'auto' }}
        >
          Fit
        </button>

          <button
            type="button"
            className="clay-button"
            onClick={() => setZoomAround(1)}
            aria-pressed={zoom === 1}
            style={{ ...BUTTON, padding: '0.35rem 0.9rem', width: 'auto' }}
          >
            100%
          </button>
        </div>
      </div>
    </div>
  );
}

const BUTTON = {
  padding: '0.3rem 0.7rem',
  fontSize: 15,
  lineHeight: 1,
  width: 38,
} as const;
