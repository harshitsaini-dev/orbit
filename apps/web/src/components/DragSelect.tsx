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
 *
 * None of that works with a finger, and it cannot be made to: dragging across
 * a list *is* scrolling it, and the browser takes the pointer away the moment
 * it decides a scroll has begun. So on a touchscreen the box is not offered at
 * all and a long press selects instead - which is what every file manager on a
 * phone does, and therefore what people already try.
 */

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Below this a drag is a click that wobbled, not an attempt to select. */
const THRESHOLD = 6;

/** Long enough not to fire while somebody is starting a scroll or a tap. */
const LONG_PRESS_MS = 450;

/** How far a finger may wander during a long press before it is a scroll. */
const LONG_PRESS_SLOP = 10;

export interface DragSelectOptions {
  /** Called with every key inside the box, as it changes. */
  onSelect: (keys: string[], additive: boolean) => void;
  /** Called when the drag was really a click on empty space. */
  onClear: () => void;
  /**
   * A long press on one item, on a touchscreen. Given the item's key, and
   * expected to toggle it - the first one enters selection mode, and tapping
   * the rest is the page's own business.
   */
  onLongPress?: (key: string) => void;
  /** Off while a dialog is open, or where selection makes no sense. */
  enabled?: boolean;
}

export function useDragSelect({
  onSelect,
  onClear,
  onLongPress,
  enabled = true,
}: DragSelectOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Rect | null>(null);

  // Held in refs rather than state: they change on every pointer move, and
  // re-rendering the page sixty times a second to track a rectangle is how a
  // drag starts to stutter.
  const origin = useRef<{ x: number; y: number } | null>(null);
  const additive = useRef(false);
  const moved = useRef(false);

  /** The touch half: a pending long press, and the tap it has to swallow. */
  const pressTimer = useRef<number | null>(null);
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);
  const swallowClick = useRef(false);

  const cancelPress = useCallback(() => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
    pressOrigin.current = null;
  }, []);

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
      /*
       * A finger on an item starts a long press instead of a box. The box is
       * never started from a touch at all: the same gesture is how the list is
       * scrolled, and fighting the browser for it loses.
       */
      if (event.pointerType === 'touch') {
        const item = (event.target as Element | null)?.closest<HTMLElement>('[data-file]');
        const key = item?.dataset['file'];
        if (!key || !onLongPress) return;

        pressOrigin.current = { x: event.clientX, y: event.clientY };
        pressTimer.current = window.setTimeout(() => {
          pressTimer.current = null;
          pressOrigin.current = null;
          // The tap that would otherwise open the file has to be swallowed:
          // a long press has already done something with it.
          swallowClick.current = true;
          onLongPress(key);
          // A short buzz, where the device has one, so the mode change is felt
          // rather than only seen.
          navigator.vibrate?.(12);
        }, LONG_PRESS_MS);

        return;
      }

      if (event.button !== 0 || !isBackground(event.target)) return;

      origin.current = { x: event.clientX, y: event.clientY };
      additive.current = event.shiftKey || event.ctrlKey || event.metaKey;
      moved.current = false;
    }

    function onPointerMove(event: PointerEvent): void {
      // A finger that has moved is scrolling, not pressing.
      const press = pressOrigin.current;
      if (press) {
        const wandered =
          Math.abs(event.clientX - press.x) > LONG_PRESS_SLOP ||
          Math.abs(event.clientY - press.y) > LONG_PRESS_SLOP;
        if (wandered) cancelPress();
      }

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
      cancelPress();
      document.body.style.userSelect = '';
      finish();
    }

    /*
     * The click that follows a long press is suppressed here rather than in
     * the row, because the row does not know a long press happened - it only
     * sees an ordinary tap, and would open the file the press just selected.
     */
    function onClickCapture(event: MouseEvent): void {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    }

    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('click', onClickCapture, true);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    // A drag that ends outside the window must not leave the page in a dragging
    // state with the rectangle still painted.
    window.addEventListener('blur', onPointerUp);

    return () => {
      cancelPress();
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('click', onClickCapture, true);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('blur', onPointerUp);
      document.body.style.userSelect = '';
    };
  }, [cancelPress, enabled, finish, onLongPress, onSelect]);

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
