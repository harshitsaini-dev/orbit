import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Selecting the way a file manager selects.
 *
 * People arrive at Orbit with thirty years of Explorer and Finder in their
 * hands: click opens, ctrl-click adds one, shift-click takes everything in
 * between, arrows walk the list, shift-arrow drags the selection along, ctrl-A
 * takes the lot and escape lets go. None of that is discoverable and all of it
 * is expected.
 *
 * Click still opens, which is the one place Orbit differs from Explorer and
 * agrees with every web file manager - and with what this app already did.
 * The modifiers are what select.
 */

/** Everything between two keys, inclusive, in display order. */
export function rangeBetween(keys: string[], from: string, to: string): string[] {
  const start = keys.indexOf(from);
  const end = keys.indexOf(to);

  // Either end missing means the list changed under the selection - a filter,
  // a new page - and there is no range to speak of.
  if (start === -1 || end === -1) return [];

  return start <= end ? keys.slice(start, end + 1) : keys.slice(end, start + 1);
}

export type ClickOutcome = 'open' | 'selected';

export interface RangeSelection {
  /**
   * What a click on an item means. `open` when no modifier was held, so the
   * caller does what it always did; `selected` when this took the click.
   */
  activate: (event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }, key: string) => ClickOutcome;
  /** The item the keyboard is on, for the caller to mark. */
  focused: string | null;
}

export function useRangeSelection({
  keys,
  selected,
  setSelected,
  container,
}: {
  /** Every selectable key, in the order they are displayed. */
  keys: string[];
  selected: Set<string>;
  setSelected: (next: Set<string>) => void;
  /**
   * The element the items are in. Arrow keys measure the rendered geometry
   * rather than assuming a shape, so one implementation moves correctly
   * through a single column and through a grid of unknown width.
   */
  container: React.RefObject<HTMLElement | null>;
}): RangeSelection {
  const [focused, setFocused] = useState<string | null>(null);
  /** Where a shift-selection counts from. Explorer calls this the anchor. */
  const anchor = useRef<string | null>(null);

  const activate = useCallback<RangeSelection['activate']>(
    (event, key) => {
      if (event.shiftKey && anchor.current) {
        setSelected(new Set(rangeBetween(keys, anchor.current, key)));
        setFocused(key);
        return 'selected';
      }

      if (event.ctrlKey || event.metaKey) {
        const next = new Set(selected);
        if (next.has(key)) next.delete(key);
        else next.add(key);

        setSelected(next);
        anchor.current = key;
        setFocused(key);
        return 'selected';
      }

      // No modifier: this is an ordinary click, and the caller opens it. The
      // anchor still moves, so a shift-click straight afterwards counts from
      // the thing just clicked - which is what Explorer does.
      anchor.current = key;
      setFocused(key);
      return 'open';
    },
    [keys, selected, setSelected],
  );

  /**
   * The item one step away, measured from what is on the screen.
   *
   * Left and right are the next and previous in order. Up and down look for the
   * item nearest horizontally in the row above or below, which in a single
   * column is simply the neighbour and in a grid is the tile above or below -
   * without this component being told how many columns there are.
   */
  const step = useCallback(
    (from: string, direction: 'up' | 'down' | 'left' | 'right'): string | null => {
      const index = keys.indexOf(from);
      if (index === -1) return null;

      if (direction === 'left') return keys[index - 1] ?? null;
      if (direction === 'right') return keys[index + 1] ?? null;

      const root = container.current;
      if (!root) return keys[direction === 'up' ? index - 1 : index + 1] ?? null;

      const boxes = new Map<string, DOMRect>();
      for (const element of root.querySelectorAll<HTMLElement>('[data-file]')) {
        const key = element.dataset['file'];
        if (key) boxes.set(key, element.getBoundingClientRect());
      }

      const current = boxes.get(from);
      if (!current) return keys[direction === 'up' ? index - 1 : index + 1] ?? null;

      let best: { key: string; distance: number } | null = null;

      for (const [key, box] of boxes) {
        const isAbove = box.bottom <= current.top + 1;
        const isBelow = box.top >= current.bottom - 1;
        if (direction === 'up' ? !isAbove : !isBelow) continue;

        // Nearest row first, then nearest horizontally within it.
        const rows = Math.abs(box.top - current.top);
        const columns = Math.abs(box.left - current.left);
        const distance = rows * 1000 + columns;

        if (!best || distance < best.distance) best = { key, distance };
      }

      return best?.key ?? null;
    },
    [keys, container],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // Typing in the filter box must not walk the list underneath it.
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable]')) return;

      /*
       * A dialog owns the keyboard while it is open. Escape in particular:
       * it closes the viewer, and clearing the selection behind it as well
       * would be one key press doing two things nobody asked for.
       */
      if (document.querySelector('[role="dialog"]')) return;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setSelected(new Set(keys));
        return;
      }

      if (event.key === 'Escape') {
        if (selected.size === 0) return;
        event.preventDefault();
        setSelected(new Set());
        return;
      }

      const directions: Record<string, 'up' | 'down' | 'left' | 'right'> = {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowLeft: 'left',
        ArrowRight: 'right',
      };

      const direction = directions[event.key];
      if (!direction) return;

      event.preventDefault();

      const from = focused ?? [...selected][selected.size - 1] ?? keys[0];
      if (!from) return;

      // The first arrow press with nothing focused lands on the first item
      // rather than skipping past it.
      const next = focused === null && !selected.size ? keys[0]! : (step(from, direction) ?? from);

      setFocused(next);

      if (event.shiftKey) {
        anchor.current ??= from;
        setSelected(new Set(rangeBetween(keys, anchor.current, next)));
      } else {
        anchor.current = next;
        setSelected(new Set([next]));
      }

      // Keep the item the keyboard moved to on the screen.
      container.current
        ?.querySelector<HTMLElement>(`[data-file="${CSS.escape(next)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    },
    [container, focused, keys, selected, setSelected, step],
  );

  /*
   * Listened for on the document rather than bound to the container in JSX.
   *
   * Two reasons. Arrow keys work as soon as the window is focused, as they do
   * in a file manager - nobody clicks the list first. And a div carrying an
   * onKeyDown is a non-native interactive element, which is a lint error and a
   * fair one: the keyboard behaviour belongs to the page, not to a box.
   */
  useEffect(() => {
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);

  return { activate, focused };
}
