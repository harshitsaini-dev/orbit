import { useRef, useState, type ComponentType } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ContextMenu, type MenuAnchor } from './ContextMenu.js';

/**
 * The whole navigation, as one control, for a screen that has no room for it.
 *
 * A sidebar on a phone is most of the screen. Laid out sideways it scrolled,
 * and hid two thirds of the pages behind a swipe nobody was told about. Wrapped
 * into chips it showed all fifteen and spent six lines doing it, which pushed
 * the files below the fold on the page people actually came for.
 *
 * A menu costs one line whatever the number of pages, and says which one you
 * are on - which the strip only did by colour, at the far end of a scroll.
 *
 * The desktop sidebar is untouched. There the list is free: it sits in a column
 * that would otherwise be empty, and a menu there would hide something that
 * costs nothing to show.
 */

export interface NavEntry {
  to: string;
  label: string;
  Icon: ComponentType<{ size?: number }>;
}

export function NavPicker({ entries }: { entries: NavEntry[] }) {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const { pathname } = useLocation();

  /*
   * The longest matching entry, not the first.
   *
   * `/developer/docs` matches both `/` and `/developer`, and picking the first
   * would leave the trigger saying "Dashboard" on a page three levels away.
   */
  const current =
    [...entries]
      .filter((entry) => pathname === entry.to || pathname.startsWith(`${entry.to}/`))
      .sort((a, b) => b.to.length - a.to.length)[0] ?? entries[0];

  if (!current) return null;

  const { Icon } = current;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="clay-button nav-picker"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-label={`Go to another page. Currently ${current.label}.`}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchor({ x: rect.left, y: rect.bottom + 4 });
        }}
      >
        <Icon size={17} />
        <span className="nav-picker__name">{current.label}</span>

        <svg
          viewBox="0 0 24 24"
          width={14}
          height={14}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ flex: 'none', opacity: 0.7 }}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {anchor && (
        <ContextMenu
          anchor={anchor}
          label="Pages"
          onClose={() => {
            setAnchor(null);
            triggerRef.current?.focus();
          }}
          items={entries.map((entry) => ({
            label: entry.label,
            icon: <entry.Icon size={16} />,
            onSelect: () => {
              if (entry.to !== current.to) navigate(entry.to);
            },
          }))}
        />
      )}
    </>
  );
}
