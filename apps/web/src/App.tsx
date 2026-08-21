import { useEffect, type ReactNode } from 'react';
import type { ThemeMode } from '@orbit/shared-types';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Avatar } from './components/Avatar.js';
import { api } from './lib/api.js';
import { useAuth } from './lib/auth.js';
import { ACCENTS, useTheme } from './lib/theme.js';
import { Account } from './routes/Account.js';
import { Home } from './routes/Home.js';
import { Login } from './routes/Login.js';
import { MyDrive } from './routes/MyDrive.js';
import { Placeholder } from './routes/Placeholder.js';
import { Quota } from './routes/Quota.js';

const NAV = [
  { to: '/', label: 'Home' },
  { to: '/my-drive', label: 'My Drive' },
  { to: '/recent', label: 'Recent' },
  { to: '/starred', label: 'Starred' },
  { to: '/shared-with-me', label: 'Shared with me' },
  { to: '/quota', label: 'Quota' },
  { to: '/developer', label: 'Developer' },
  { to: '/account', label: 'Account' },
];

function ThemeSwitch() {
  const { theme, setTheme, accent, setAccent } = useTheme();
  const { user, refresh } = useAuth();

  /**
   * Appearance is one setting, not two. Changing it here applies immediately
   * and is saved to the profile, so it survives a reload and follows the
   * account to another device — otherwise the profile value would simply
   * overwrite this choice on the next load.
   */
  function apply(changes: { theme?: ThemeMode; accent?: string }) {
    if (changes.theme) setTheme(changes.theme);
    if (changes.accent) setAccent(changes.accent);

    if (!user) return;
    void api('/api/profile', { method: 'PATCH', body: changes })
      .then(() => refresh())
      .catch(() => {
        // The local change stands; it just will not follow to another device.
      });
  }

  return (
    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
      <div className="clay-sunken" style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 'var(--radius-pill)' }}>
        {(['light', 'system', 'dark'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => apply({ theme: mode })}
            aria-pressed={theme === mode}
            className="clay-button"
            style={{
              padding: '0.35rem 0.9rem',
              fontSize: 13,
              boxShadow: theme === mode ? 'var(--shadow-clay)' : 'none',
              background: theme === mode ? 'var(--surface)' : 'transparent',
            }}
          >
            {mode}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {ACCENTS.map((option) => (
          <button
            key={option.value}
            type="button"
            title={option.name}
            aria-label={`Accent ${option.name}`}
            aria-pressed={accent === option.value}
            onClick={() => apply({ accent: option.value })}
            style={{
              width: 24,
              height: 24,
              borderRadius: '50%',
              border: accent === option.value ? '2px solid var(--text)' : '2px solid transparent',
              background: option.value,
              cursor: 'pointer',
            }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The saved profile wins over whatever this browser last chose, so the same
 * account looks the same on a second device. Runs only when the stored value
 * actually differs, to avoid fighting a change the user just made here.
 */
function ProfileAppearance() {
  const { user } = useAuth();
  const { theme, accent, setTheme, setAccent } = useTheme();

  useEffect(() => {
    if (!user) return;
    if (user.theme !== theme) setTheme(user.theme);
    if (user.accent !== accent) setAccent(user.accent);
    // Deliberately keyed on the profile: a local change must not be undone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.theme, user?.accent]);

  return null;
}

function AccountMenu() {
  const { user, mode, logout } = useAuth();
  if (!user) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
      <Link to="/account" aria-label="Your account" style={{ display: 'flex' }}>
        <Avatar user={user} size={32} />
      </Link>
      <span style={{ fontSize: 13, color: 'var(--text-muted)' }} data-testid="current-user">
        {user.displayName || user.email}
      </span>
      {mode === 'hosted' && (
        <button type="button" className="clay-button" style={{ padding: '0.4rem 1rem', fontSize: 13 }} onClick={() => void logout()}>
          Sign out
        </button>
      )}
    </div>
  );
}

/** Blocks a route until a session exists, remembering where the user was headed. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <div style={{ padding: '2rem', color: 'var(--text-muted)' }}>Loading…</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

function RequireSuperadmin({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  // Mirrors the API, which 404s rather than 403s so /admin is not confirmed to exist.
  if (user?.role !== 'superadmin') return <Placeholder title="Not found" phase="-" />;
  return <>{children}</>;
}

function Workspace() {
  return (
    <div className="app-shell">
      <ProfileAppearance />
      <header className="app-header">
        <strong style={{ fontSize: 20, letterSpacing: '-0.03em' }}>Orbit</strong>
        <div className="app-header__actions">
          <AccountMenu />
          <ThemeSwitch />
        </div>
      </header>

      <div className="app-body">
        <nav className="clay app-nav" aria-label="Workspace">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === '/'} className="app-nav__link">
              {item.label}
            </NavLink>
          ))}
        </nav>

        <main className="app-main">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/my-drive" element={<MyDrive />} />
            <Route path="/recent" element={<Placeholder title="Recent" phase="Phase 4" />} />
            <Route path="/starred" element={<Placeholder title="Starred" phase="Phase 4" />} />
            <Route path="/shared-with-me" element={<Placeholder title="Shared with me" phase="Phase 4" />} />
            <Route path="/quota" element={<Quota />} />
            <Route path="/account" element={<Account />} />
            <Route path="/developer" element={<Placeholder title="Developer" phase="Phase 11" />} />
            <Route path="/developer/docs" element={<Placeholder title="API docs" phase="Phase 11" />} />
            <Route
              path="/admin"
              element={
                <RequireSuperadmin>
                  <Placeholder title="Admin" phase="Phase 8" />
                </RequireSuperadmin>
              }
            />
            <Route path="*" element={<Placeholder title="Not found" phase="-" />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="*"
        element={
          <RequireAuth>
            <Workspace />
          </RequireAuth>
        }
      />
    </Routes>
  );
}
