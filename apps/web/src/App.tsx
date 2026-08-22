import { useEffect, type ReactNode } from 'react';
import type { ThemeMode } from '@orbit/shared-types';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AccountMenu } from './components/AccountMenu.js';
import { BrandMark } from './components/BrandMark.js';
import {
  ClockIcon,
  CodeIcon,
  DashboardIcon,
  DriveIcon,
  PersonIcon,
  QuotaIcon,
  UploadFileIcon,
  SharedIcon,
  StarOutlineIcon,
} from './components/Icons.js';
import { StatusScreen } from './components/StatusScreen.js';
import { UploadIndicator } from './components/UploadIndicator.js';
import { useAuth } from './lib/auth.js';
import { useOnline } from './lib/online.js';
import { useTheme } from './lib/theme.js';
import { Account } from './routes/Account.js';
import { Dashboard } from './routes/Dashboard.js';
import { Landing } from './routes/Landing.js';
import { Login } from './routes/Login.js';
import { MyDrive } from './routes/MyDrive.js';
import { Placeholder } from './routes/Placeholder.js';
import { Quota } from './routes/Quota.js';
import { Uploads } from './routes/Uploads.js';
import { WorkspaceViewPage } from './routes/WorkspaceView.js';

const NAV = [
  { to: '/', label: 'Dashboard', Icon: DashboardIcon },
  { to: '/my-drive', label: 'My Drive', Icon: DriveIcon },
  { to: '/recent', label: 'Recent', Icon: ClockIcon },
  { to: '/starred', label: 'Starred', Icon: StarOutlineIcon },
  { to: '/shared-with-me', label: 'Shared with me', Icon: SharedIcon },
  { to: '/quota', label: 'Quota', Icon: QuotaIcon },
  { to: '/uploads', label: 'Uploads', Icon: UploadFileIcon },
  { to: '/developer', label: 'Developer', Icon: CodeIcon },
  { to: '/account', label: 'Account', Icon: PersonIcon },
];

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
  if (user?.role !== 'superadmin') return <StatusScreen kind="not-found" />;
  return <>{children}</>;
}

function Workspace({ online }: { online: boolean }) {
  return (
    <div className="app-shell">
      <ProfileAppearance />
      <header className="app-header">
        <Link
          to="/"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            textDecoration: 'none',
            color: 'var(--text)',
          }}
        >
          <BrandMark size={28} />
          <strong style={{ fontSize: 20, letterSpacing: '-0.03em' }}>Orbit</strong>
        </Link>
        <div className="app-header__actions">
          <UploadIndicator />
          <AccountMenu />
        </div>
      </header>

      {!online && (
        <p className="offline-bar" role="status">
          <span aria-hidden="true">●</span>
          Offline — showing folders from this device. Opening and downloading files needs a
          connection.
        </p>
      )}

      <div className="app-body">
        <nav className="clay app-nav" aria-label="Workspace">
          {NAV.map(({ to, label, Icon }) => (
            <NavLink key={to} to={to} end={to === '/'} className="app-nav__link">
              <Icon />
              {label}
            </NavLink>
          ))}
        </nav>

        <main className="app-main">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/my-drive" element={<MyDrive />} />
            <Route path="/recent" element={<WorkspaceViewPage view="recent" />} />
            <Route path="/starred" element={<WorkspaceViewPage view="starred" />} />
            <Route path="/shared-with-me" element={<WorkspaceViewPage view="shared" />} />
            <Route path="/quota" element={<Quota />} />
            <Route path="/uploads" element={<Uploads />} />
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
            <Route path="*" element={<StatusScreen kind="not-found" />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

export function App() {
  const { user, loading } = useAuth();
  const online = useOnline();

  // Waiting avoids a flash of the landing page for someone already signed in.
  if (loading) return null;

  /*
   * Offline, a signed-in workspace keeps working: the directory cache holds the
   * tree, so folders still browse and only the bytes are missing. Taking the
   * whole app away would throw that away to say something a bar can say.
   *
   * Signed out there is nothing cached to browse, so the screen is the honest
   * answer.
   */
  if (!online && !user) {
    return (
      <div className="status-shell">
        <StatusScreen kind="offline" standalone />
      </div>
    );
  }

  const workspace = (
    <RequireAuth>
      <Workspace online={online} />
    </RequireAuth>
  );

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* The root is the only address that differs by who is asking: a pitch
          for a visitor, their own storage for a signed-in user. */}
      <Route path="/" element={user ? workspace : <Landing />} />
      <Route path="*" element={workspace} />
    </Routes>
  );
}
