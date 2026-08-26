import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * The right-click menu for a file or a folder.
 *
 * Orbit replaces the browser's own because the browser's offers "Save image
 * as…" and "Open link in new tab" on things that are neither - the rows are not
 * links, and the bytes behind them are proxied. Its own menu can offer what
 * actually applies here.
 *
 * It closes on anything that would move it away from the thing it belongs to:
 * a click elsewhere, a scroll, a resize, or Escape. A menu left floating beside
 * a row that has scrolled off is worse than no menu.
 */

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  /** Rendered in the danger colour and separated from the rest. */
  danger?: boolean;
  disabled?: boolean;
}

export interface MenuAnchor {
  x: number;
  y: number;
}

/** Kept away from the very edge so the menu never sits half off-screen. */
const MARGIN = 8;

export function ContextMenu({
  anchor,
  items,
  onClose,
  label,
  filterPlaceholder,
}: {
  anchor: MenuAnchor;
  items: MenuItem[];
  onClose: () => void;
  label: string;
  /**
   * Turns on a filter field at the top, with this as its placeholder.
   *
   * Opt-in rather than automatic. A right-click menu has eight actions and
   * knows all of them by heart; a list of twenty-one Gmail addresses is
   * something nobody can scan, and the only way to tell them apart is to type
   * the part that differs.
   */
  filterPlaceholder?: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState<MenuAnchor>(anchor);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return items;
    return items.filter((item) => item.label.toLowerCase().includes(term));
  }, [items, query]);

  // Measured after mount rather than guessed: the menu's height depends on how
  // many actions this particular file has, and flipping it upwards is only
  // right when it would otherwise run off the bottom.
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;

    const { width, height } = element.getBoundingClientRect();
    const x = Math.min(anchor.x, window.innerWidth - width - MARGIN);
    const y =
      anchor.y + height + MARGIN > window.innerHeight
        ? Math.max(MARGIN, anchor.y - height)
        : anchor.y;

    setPosition({ x: Math.max(MARGIN, x), y });

    // The field, when there is one: somebody who opened a list of twenty-one
    // drives opened it to find one, and should be able to start typing.
    if (filterRef.current) filterRef.current.focus();
    else element.focus();
  }, [anchor]);

  useEffect(() => {
    /*
     * A scroll *inside* the menu is not a scroll away from it.
     *
     * The list scrolls now that it is capped, and closing on any scroll at all
     * meant a long menu shut itself the moment somebody reached for what was
     * below the fold.
     */
    const close = (event?: Event) => {
      if (event && menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };

    // Capture, so a scroll inside the file list closes it too rather than only
    // a scroll of the window.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [onClose]);

  const usable = shown.filter((item) => !item.disabled);

  function move(delta: number) {
    setActive((current) => {
      const next = current + delta;
      if (next < 0) return shown.length - 1;
      if (next >= shown.length) return 0;
      return next;
    });
  }

  /** Every key that drives the menu, wherever focus is - list or filter field. */
  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'Escape') {
      onClose();
    } else if (event.key === 'ArrowDown') {
      move(1);
    } else if (event.key === 'ArrowUp') {
      move(-1);
    } else if (event.key === 'Enter') {
      const item = shown[active];
      if (item && !item.disabled) {
        item.onSelect();
        onClose();
      }
    } else if (event.key === ' ' && !filterPlaceholder) {
      // Only without a filter field, where a space is a keystroke rather than
      // a selection.
      const item = shown[active];
      if (item && !item.disabled) {
        item.onSelect();
        onClose();
      }
    } else {
      return;
    }
    event.preventDefault();
  }

  return (
    <>
      {/*
        A transparent sheet rather than a document listener: it catches the
        click that dismisses the menu before that click also selects whatever
        happens to be underneath.
      */}
      {/* No keyboard handler: a transparent dismiss sheet is not reachable by
          keyboard, and Escape already closes the menu. */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div
        className="context-menu__catcher"
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />

      <div
        ref={menuRef}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        className="clay context-menu"
        style={{ left: position.x, top: position.y }}
        onKeyDown={onKeyDown}
      >
        {filterPlaceholder && (
          <input
            ref={filterRef}
            type="text"
            className="context-menu__filter"
            placeholder={filterPlaceholder}
            aria-label={filterPlaceholder}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              // Back to the top, or Enter would choose a row from the previous
              // set of matches.
              setActive(0);
            }}
          />
        )}

        <div className="context-menu__list">
          {shown.map((item, index) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              data-danger={item.danger ? '' : undefined}
              data-active={index === active && usable.length > 0 ? '' : undefined}
              onMouseEnter={() => setActive(index)}
              onClick={() => {
                item.onSelect();
                onClose();
              }}
            >
              <span className="context-menu__icon">{item.icon}</span>
              {/* Its own element so it can be truncated: an ellipsis cannot be
                  applied to a bare text node inside a flex row. */}
              <span className="context-menu__label">{item.label}</span>
            </button>
          ))}

          {/* Said rather than shown as an empty box, which reads as broken. */}
          {shown.length === 0 && <p className="context-menu__empty">No matches</p>}
        </div>
      </div>
    </>
  );
}

/**
 * Tracks where a right-click happened and on what.
 *
 * Returning the target alongside the point keeps the menu's contents and its
 * position in one piece of state, so they can never disagree about which file
 * is being acted on.
 */
export function useContextMenu<T>() {
  const [state, setState] = useState<{ anchor: MenuAnchor; target: T } | null>(null);

  function open(event: React.MouseEvent, target: T): void {
    event.preventDefault();
    event.stopPropagation();
    setState({ anchor: { x: event.clientX, y: event.clientY }, target });
  }

  /**
   * The same menu, opened from a button rather than from a right-click.
   *
   * A menu belonging to a control should hang under that control rather than
   * under wherever the pointer happened to be - on a touchscreen those are the
   * same place, and on a desk they are not.
   */
  function openAt(anchor: MenuAnchor, target: T): void {
    setState({ anchor, target });
  }

  return { state, open, openAt, close: () => setState(null) };
}
