import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

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
}: {
  anchor: MenuAnchor;
  items: MenuItem[];
  onClose: () => void;
  label: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<MenuAnchor>(anchor);
  const [active, setActive] = useState(0);

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
    element.focus();
  }, [anchor]);

  useEffect(() => {
    const close = () => onClose();

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

  const usable = items.filter((item) => !item.disabled);

  function move(delta: number) {
    setActive((current) => {
      const next = current + delta;
      if (next < 0) return items.length - 1;
      if (next >= items.length) return 0;
      return next;
    });
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
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onClose();
          } else if (event.key === 'ArrowDown') {
            move(1);
          } else if (event.key === 'ArrowUp') {
            move(-1);
          } else if (event.key === 'Enter' || event.key === ' ') {
            const item = items[active];
            if (item && !item.disabled) {
              item.onSelect();
              onClose();
            }
          } else {
            return;
          }
          event.preventDefault();
        }}
      >
        {items.map((item, index) => (
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
            {item.label}
          </button>
        ))}
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

  return { state, open, close: () => setState(null) };
}
