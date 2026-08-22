import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Drag a box over files to select them, the way a file manager does.
 *
 * Every page that has checkboxes gets this from one hook, so it behaves the
 * same everywhere and a page added later does not have to remember.
 *
 * The rules are the ones people already have from every other file manager,
 * and getting any of them wrong makes it feel broken rather than merely
 * different:
 *
 * - A drag starts on empty space, never on a file. Starting one on a tile
 *   would fight with clicking it, and starting one on a button would fight
 *   with pressing it.
 * - A plain drag replaces the selection; holding shift or ctrl adds to it.
 * - A drag that never really moved is a click on the background, which clears
 *   the selection rather than selecting nothing in a rectangle.
 */

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Below this a drag is a click that wobbled, not an attempt to select. */
const THRESHOLD = 6;

export interface DragSelectOptions {
  /** Called with every key inside the box, as it changes. */
  onSelect: (keys: string[], additive: boolean) => void;
  /** Called when the drag was really a click on empty space. */
  onClear: () => void;
  /** Off while a dialog is open, or where selection makes no sense. */
  enabled?: boolean;
}

export function useDragSelect({ onSelect, onClear, enabled = true }: DragSelectOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Rect | null>(null);

  // Held in refs rather than state: they change on every pointer move, and
  // re-rendering the page sixty times a second to track a rectangle is how a
  // drag starts to stutter.
  const origin = useRef<{ x: number; y: number } | null>(null);
  const additive = useRef(false);
  const moved = useRef(false);

  const finish = useCallback(() => {
    if (origin.current && !moved.current) onClear();
    origin.current = null;
    moved.current = false;
    setBox(null);
  }, [onClear]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;

    function isBackground(target: EventTarget | null): boolean {
      if (!(target instanceof Element)) return false;
      // Anything a person can act on is not empty space.
      return !target.closest('a, button, input, label, select, textarea, [data-file]');
    }

    function onPointerDown(event: PointerEvent): void {
      if (event.button !== 0 || !isBackground(event.target)) return;

      origin.current = { x: event.clientX, y: event.clientY };
      additive.current = event.shiftKey || event.ctrlKey || event.metaKey;
      moved.current = false;
    }

    function onPointerMove(event: PointerEvent): void {
      const start = origin.current;
      if (!start) return;

      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;

      if (!moved.current && Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) return;

      if (!moved.current) {
        moved.current = true;
        // Only now, so a click that wobbled never blocks the page's own
        // text selection.
        document.body.style.userSelect = 'none';
      }

      const rect: Rect = {
        left: Math.min(start.x, event.clientX),
        top: Math.min(start.y, event.clientY),
        width: Math.abs(dx),
        height: Math.abs(dy),
      };
      setBox(rect);

      const hit: string[] = [];
      for (const element of container!.querySelectorAll<HTMLElement>('[data-file]')) {
        const bounds = element.getBoundingClientRect();

        // Touching, not containing: a file manager selects what the box brushes
        // past, and requiring full containment makes a drag feel like it missed.
        const overlaps =
          bounds.left < rect.left + rect.width &&
          bounds.right > rect.left &&
          bounds.top < rect.top + rect.height &&
          bounds.bottom > rect.top;

        if (overlaps) hit.push(element.dataset.file!);
      }

      onSelect(hit, additive.current);
    }

    function onPointerUp(): void {
      document.body.style.userSelect = '';
      finish();
    }

    container.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    // A drag that ends outside the window must not leave the page in a dragging
    // state with the rectangle still painted.
    window.addEventListener('blur', onPointerUp);

    return () => {
      container.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('blur', onPointerUp);
      document.body.style.userSelect = '';
    };
  }, [enabled, finish, onSelect]);

  return { containerRef, box };
}

/** The rectangle itself. Fixed, because it is measured against the viewport. */
export function DragSelectBox({ box }: { box: { left: number; top: number; width: number; height: number } | null }) {
  if (!box) return null;

  return (
    <div
      className="drag-box"
      aria-hidden="true"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    />
  );
}
