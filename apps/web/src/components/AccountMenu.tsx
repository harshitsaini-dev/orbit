import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ThemeMode } from '@orbit/shared-types';
import { Avatar } from './Avatar.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { cacheSize, clearCache } from '../lib/cache.js';
import { ACCENTS, useTheme } from '../lib/theme.js';

/**
 * Everything about "you" in one place, behind the avatar.
 *
 * Appearance used to sit in the header as eight loose controls, which made the
 * top of every page about settings rather than about the workspace.
 */
export function AccountMenu() {
  const { user, mode, logout, refresh } = useAuth();
  /**
   * How much of the directory tree is held locally.
   *
   * Offered here because a cache nobody can see or clear is a cache people stop
   * trusting the moment anything looks stale.
   */
  const [cached, setCached] = useState({ folders: 0, files: 0 });
  const { theme, accent, setTheme, setAccent } = useTheme();

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  // Only while the menu is open: counting on every render would read the whole
  // store to draw one line.
  useEffect(() => {
    if (open) void cacheSize().then(setCached);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setOpen(false);
      // Focus goes back where it came from, rather than to the top of the page.
      buttonRef.current?.focus();
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;

  /**
   * Appearance is one setting, not two. It applies at once and is saved to the
   * profile, so it survives a reload and follows the account to another device.
   */
  function apply(changes: { theme?: ThemeMode; accent?: string }) {
    if (changes.theme) setTheme(changes.theme);
    if (changes.accent) setAccent(changes.accent);

    void api('/api/profile', { method: 'PATCH', body: changes })
      .then(() => refresh())
      .catch(() => {
        // The local change stands; it just will not follow to another device.
      });
  }

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        ref={buttonRef}
        type="button"
        className="clay-button"
        aria-haspopup="menu"
        aria-label="Account menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0.3rem 0.75rem 0.3rem 0.3rem',
          borderRadius: 'var(--radius-pill)',
          maxWidth: 220,
        }}
      >
        <Avatar user={user} size={30} />
        <span
          data-testid="current-user"
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {user.displayName || user.email}
        </span>
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Account"
          className="clay"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            zIndex: 50,
            width: 'min(280px, calc(100vw - 2rem))',
            padding: '0.9rem',
            display: 'grid',
            gap: '0.9rem',
          }}
        >
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 }}>
            <Avatar user={user} size={38} />
            <div style={{ display: 'grid', gap: 1, minWidth: 0 }}>
              {user.displayName && (
                <strong style={{ fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {user.displayName}
                </strong>
              )}
              <span
                style={{
                  fontSize: 12,
                  color: 'var(--text-muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {user.email}
              </span>
            </div>
          </div>

          <div style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>Theme</span>
            <div className="clay-sunken" style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 'var(--radius-pill)' }}>
              {(['light', 'system', 'dark'] as ThemeMode[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="menuitemradio"
                  aria-checked={theme === option}
                  onClick={() => apply({ theme: option })}
                  className="clay-button"
                  style={{
                    flex: 1,
                    padding: '0.35rem 0.5rem',
                    fontSize: 12,
                    boxShadow: theme === option ? 'var(--shadow-clay)' : 'none',
                    background: theme === option ? 'var(--surface)' : 'transparent',
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>Accent</span>
            <div style={{ display: 'flex', gap: 8 }}>
              {ACCENTS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={accent === option.value}
                  aria-label={`Accent ${option.name}`}
                  title={option.name}
                  onClick={() => apply({ accent: option.value })}
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: '50%',
                    border: accent === option.value ? '2px solid var(--text)' : '2px solid transparent',
                    background: option.value,
                    cursor: 'pointer',
                    padding: 0,
                  }}
                />
              ))}
            </div>
          </div>

          <div style={{ display: 'grid', gap: 6, borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                void clearCache().then(() => setCached({ folders: 0, files: 0 }));
              }}
              style={{
                padding: '0.5rem 0.6rem',
                borderRadius: 'var(--radius-sm)',
                background: 'none',
                border: 0,
                textAlign: 'left',
                font: 'inherit',
                fontSize: 14,
                color: 'var(--text)',
                cursor: 'pointer',
              }}
            >
              {cached.folders === 0
                ? 'Nothing cached'
                : `Clear ${cached.folders} cached ${cached.folders === 1 ? 'folder' : 'folders'}`}
            </button>

            <Link
              to="/account"
              role="menuitem"
              onClick={() => setOpen(false)}
              style={{
                padding: '0.5rem 0.6rem',
                borderRadius: 'var(--radius-sm)',
                textDecoration: 'none',
                color: 'var(--text)',
                fontSize: 14,
              }}
            >
              Account settings
            </Link>

            {/*
              Local mode has no session to end - every request is the owner of
              this machine - so signing out would clear nothing and the next
              request would be signed in again. Saying so beats a button that
              appears broken, and beats silence that reads as a missing feature.
            */}
            {mode === 'local' && (
              <p
                style={{
                  margin: 0,
                  padding: '0.5rem 0.6rem',
                  fontSize: 12.5,
                  lineHeight: 1.45,
                  color: 'var(--text-muted)',
                }}
              >
                Running in local mode, signed in as the owner of this machine. There is no session
                to sign out of — set <code>AUTH_MODE=hosted</code> in <code>.env</code> and restart
                for email sign-in.
              </p>
            )}

            {mode === 'hosted' && (
              <button
                type="button"
                role="menuitem"
                onClick={() => void logout()}
                style={{
                  padding: '0.5rem 0.6rem',
                  borderRadius: 'var(--radius-sm)',
                  background: 'none',
                  border: 0,
                  textAlign: 'left',
                  font: 'inherit',
                  fontSize: 14,
                  color: 'var(--danger)',
                  cursor: 'pointer',
                }}
              >
                Sign out
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
