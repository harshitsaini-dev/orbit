import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * The clay-styled replacement for window.prompt and window.confirm.
 *
 * Those are drawn by the browser, ignore the theme entirely, cannot be styled,
 * and on some platforms are suppressed outright — so a feature built on them can
 * silently stop working.
 */
export function Modal({
  title,
  description,
  children,
  onClose,
  labelledBy,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  labelledBy?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const titleId = labelledBy ?? generatedId;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();

      if (event.key !== 'Tab') return;

      // Keep Tab inside the dialog: focus escaping to the page behind is how a
      // modal stops being modal.
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Focus the first field, so a name can be typed without reaching for the mouse.
    const focusTarget = panelRef.current?.querySelector<HTMLElement>('input, button');
    focusTarget?.focus();

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    /* The backdrop click is a mouse convenience on top of Escape and the close
       button, both of which a keyboard user has. */
    /* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */
    <div
      className="modal-scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: 'rgba(8, 10, 16, 0.55)',
        backdropFilter: 'blur(4px)',
        display: 'grid',
        placeItems: 'center',
        padding: '1rem',
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="clay modal-panel"
        style={{
          width: 'min(420px, 100%)',
          /*
           * A grid item's automatic minimum is its content, and a file name
           * with no spaces in it has no place to break - so a dialog titled
           * with one grew past the screen and took its own buttons with it.
           */
          maxWidth: '100%',
          minWidth: 0,
          padding: 'clamp(1.25rem, 4vw, 1.75rem)',
          display: 'grid',
          gap: '1rem',
        }}
      >
        <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
          <h2 id={titleId} style={{ fontSize: '1.15rem', overflowWrap: 'anywhere' }}>
            {title}
          </h2>
          {description && (
            <p style={{ color: 'var(--text-muted)', fontSize: 14, margin: 0, overflowWrap: 'anywhere' }}>
              {description}
            </p>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

export function DialogActions({ children }: { children: ReactNode }) {
  return (
    <div className="dialog-actions">{children}</div>
  );
}
