import { useRef, useState } from 'react';
import type { PublicAccount } from '@orbit/shared-types';
import { ContextMenu, type MenuAnchor } from './ContextMenu.js';
import { ProviderIcon } from './ProviderIcon.js';

/**
 * Which drive you are looking at, and how to change it.
 *
 * This was a row of chips, and before that a row that scrolled sideways. The
 * scroller hid every drive past the third with nothing to say so; the wrapped
 * row showed them all and then took three lines of the screen to do it, which
 * on eight accounts pushed the files themselves down the page.
 *
 * A menu costs one line whatever the number. The trade is a click to see the
 * list - worth it, because switching drives is something people do
 * occasionally and reading their files is what they do constantly.
 *
 * Not a `<select>`. A native one cannot show which service each account is on,
 * and three Gmail addresses in a list are indistinguishable without it.
 */
export function DrivePicker({
  accounts,
  accountId,
  onChoose,
}: {
  accounts: PublicAccount[];
  accountId: string | null;
  onChoose: (id: string) => void;
}) {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const current = accounts.find((account) => account.id === accountId) ?? accounts[0];
  if (!current) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="clay-button drive-picker"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={(event) => {
          // Under the trigger rather than at the pointer: this menu belongs to
          // a control, not to wherever somebody happened to click.
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchor({ x: rect.left, y: rect.bottom + 4 });
        }}
      >
        <ProviderIcon provider={current.catalogueKey ?? current.provider} size={18} />
        <span className="drive-picker__name">{current.nickname}</span>

        {/* Says there is more here without spending a word on it. */}
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

        {accounts.length > 1 && <span className="drive-picker__count">{accounts.length}</span>}
      </button>

      {anchor && (
        <ContextMenu
          anchor={anchor}
          label="Switch drive"
          onClose={() => {
            setAnchor(null);
            // Focus goes back where it came from, or a keyboard user is left
            // at the top of the document.
            triggerRef.current?.focus();
          }}
          items={accounts.map((account) => ({
            label: account.nickname,
            icon: <ProviderIcon provider={account.catalogueKey ?? account.provider} size={16} />,
            // Choosing the one already open is not an error, just nothing -
            // and greying it out would make the current drive look broken.
            onSelect: () => {
              if (account.id !== accountId) onChoose(account.id);
            },
          }))}
        />
      )}
    </>
  );
}
