import { useEffect, useState, type ReactNode } from 'react';

/**
 * The whole-window target for a dragged file.
 *
 * Scoped to the file list, the drop area stopped at the edge of a panel:
 * dragging onto the sidebar, the header, or the empty space beside the list
 * did nothing, and a drop that misses reads as broken rather than as
 * out-of-bounds. The window is the target now, and the overlay says where the
 * files will land before they are let go.
 *
 * A file dropped anywhere outside a drop target also makes the browser navigate
 * away to that file, abandoning the page - so `dragover` is cancelled window-
 * wide whether or not this component is showing anything.
 */

/** Whether a drag carries files, as opposed to selected text or a link. */
function carriesFiles(transfer: DataTransfer | null): boolean {
  return Array.from(transfer?.types ?? []).includes('Files');
}

export function DropZone({
  label,
  onFiles,
  disabled = false,
  children,
}: {
  /** Where the files would go, e.g. "Upload to /Photos/2026". */
  label: string;
  onFiles: (files: File[], transfer: DataTransfer) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const [over, setOver] = useState(false);

  useEffect(() => {
    /**
     * Counted rather than toggled: dragging across a child fires `dragleave`
     * for the element being left before `dragenter` for the one being entered,
     * so a boolean flickers off every time the pointer crosses a row.
     */
    let depth = 0;

    function onEnter(event: DragEvent) {
      if (!carriesFiles(event.dataTransfer)) return;
      depth += 1;
      if (!disabled) setOver(true);
    }

    function onOver(event: DragEvent) {
      if (!carriesFiles(event.dataTransfer)) return;
      // Without this the browser treats the drop as "open this file", replacing
      // the page with the file's contents and losing whatever was in progress.
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
      }
    }

    function onLeave(event: DragEvent) {
      if (!carriesFiles(event.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    }

    function onDrop(event: DragEvent) {
      depth = 0;
      setOver(false);
      if (!carriesFiles(event.dataTransfer)) return;

      event.preventDefault();
      if (disabled || !event.dataTransfer) return;

      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) onFiles(files, event.dataTransfer);
    }

    // A drag that ends outside the window never fires drop, and the overlay
    // would stay up over a page nobody is dragging onto any more.
    const reset = () => {
      depth = 0;
      setOver(false);
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragend', reset);
    window.addEventListener('blur', reset);

    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', reset);
      window.removeEventListener('blur', reset);
    };
  }, [onFiles, disabled]);

  if (!over) return <>{children}</>;

  return (
    <>
      {children}
      <div className="dropzone" role="presentation">
        <div className="clay dropzone__card">
          <span className="dropzone__glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24" width={34} height={34} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
              <path d="M12 16.2V4.4" />
              <path d="M7.6 8.8 12 4.4l4.4 4.4" />
              <path d="M4.2 15.6v3.2a1.6 1.6 0 0 0 1.6 1.6h12.4a1.6 1.6 0 0 0 1.6-1.6v-3.2" />
            </svg>
          </span>
          <strong>{label}</strong>
          <span>Release to start uploading.</span>
        </div>
      </div>
    </>
  );
}
