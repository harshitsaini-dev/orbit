import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { PublicAccount } from '@orbit/shared-types';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AccountMenu } from './components/AccountMenu.js';
import { BrandMark } from './components/BrandMark.js';
import {
  ClockIcon,
  CodeIcon,
  DashboardIcon,
  DriveIcon,
  PersonIcon,
  CollectionsIcon,
  DuplicatesIcon,
  QuotaIcon,
  SchedulesIcon,
  UploadFileIcon,
  SharedDrivesIcon,
  SharedIcon,
  ShieldIcon,
  StarOutlineIcon,
  LinkIcon,
  TrashBinIcon,
} from './components/Icons.js';
import { StatusScreen } from './components/StatusScreen.js';
import { Spotlight, useSpotlightShortcut } from './components/Spotlight.js';
import { UploadIndicator } from './components/UploadIndicator.js';
import { api } from './lib/api.js';
import { useAuth } from './lib/auth.js';
import { useOnline } from './lib/online.js';
import { useTheme } from './lib/theme.js';
import { Account } from './routes/Account.js';
import { Dashboard } from './routes/Dashboard.js';
import { Landing } from './routes/Landing.js';
import { Login } from './routes/Login.js';
import { MyDrive } from './routes/MyDrive.js';
import { ApiDocs } from './routes/ApiDocs.js';
import { Developer } from './routes/Developer.js';
import { Collections } from './routes/Collections.js';
import { Duplicates } from './routes/Duplicates.js';
import { Quota } from './routes/Quota.js';
import { Uploads } from './routes/Uploads.js';
import { Admin } from './routes/Admin.js';
import { Links } from './routes/Links.js';
import { Trash } from './routes/Trash.js';
import { Schedules } from './routes/Schedules.js';
import { SharedDrives } from './routes/SharedDrives.js';
import { WorkspaceViewPage } from './routes/WorkspaceView.js';

const NAV = [
  { to: '/', label: 'Dashboard', Icon: DashboardIcon },
  { to: '/my-drive', label: 'My Drive', Icon: DriveIcon },
  { to: '/recent', label: 'Recent', Icon: ClockIcon },
  { to: '/starred', label: 'Starred', Icon: StarOutlineIcon },
  { to: '/collections', label: 'Collections', Icon: CollectionsIcon },
  { to: '/duplicates', label: 'Duplicates', Icon: DuplicatesIcon },
  { to: '/links', label: 'Links', Icon: LinkIcon },
  { to: '/trash', label: 'Bin', Icon: TrashBinIcon },
  { to: '/schedules', label: 'Schedules', Icon: SchedulesIcon },
  { to: '/shared-with-me', label: 'Shared with me', Icon: SharedIcon },
  { to: '/shared-drives', label: 'Shared drives', Icon: SharedDrivesIcon },
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

/**
 * Every address the workspace actually has.
 *
 * Kept beside the route table rather than derived from it because it answers a
 * different question: not "what draws here" but "is this a page at all". An
 * address that is not one gets the whole screen to say so, rather than a panel
 * beside a working sidebar - drawn in the content area a 404 reads as one
 * broken widget, and people click past it.
 */
const PATHS = new Set([
  '/',
  '/my-drive',
  '/recent',
  '/starred',
  '/shared-with-me',
  '/shared-drives',
  '/collections',
  '/duplicates',
  '/links',
  '/trash',
  '/schedules',
  '/quota',
  '/uploads',
  '/account',
  '/developer',
  '/developer/docs',
  '/admin',
]);

function Workspace({ online }: { online: boolean }) {
  const { pathname } = useLocation();
  // Only for deciding whether the admin surface is offered at all.
  const { user } = useAuth();
  const [spotlight, setSpotlight] = useState(false);
  const [accounts, setAccounts] = useState<PublicAccount[]>([]);

  const openSpotlight = useCallback(() => setSpotlight(true), []);
  useSpotlightShortcut(openSpotlight);

  // Loaded once for the whole workspace: Spotlight needs to say which service
  // each result came from, and asking again on every open would make the
  // shortcut feel slower than the search behind it.
  useEffect(() => {
    const controller = new AbortController();
    api<{ accounts: PublicAccount[] }>('/api/accounts', { signal: controller.signal })
      .then(({ accounts: rows }) => setAccounts(rows))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  // Before the shell, not inside it: the point is that there is no page here.
  if (!PATHS.has(pathname)) return <StatusScreen kind="not-found" />;

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
          <button
            type="button"
            className="clay-button spotlight__open"
            onClick={openSpotlight}
            aria-label="Search everything"
          >
            <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true" style={{ display: 'block' }}>
              <circle cx="10.8" cy="10.8" r="6.4" />
              <path d="M15.5 15.5 20.6 20.6" />
            </svg>
            <span>Search</span>
            <kbd>{navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl'} K</kbd>
          </button>

          <UploadIndicator />
          <AccountMenu />
        </div>
      </header>

      {spotlight && <Spotlight accounts={accounts} onClose={() => setSpotlight(false)} />}

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

          {/*
            * Shown to a superadmin and to nobody else.
            *
            * The page has always been there and nothing linked to it, so the
            * only way in was typing the address - which is a poor way to reach
            * a page somebody is meant to use. Hiding it from everyone else
            * matches the API, which answers 404 rather than 403 so the admin
            * surface is not confirmed to exist.
            */}
          {user?.role === 'superadmin' && (
            <NavLink to="/admin" className="app-nav__link">
              <ShieldIcon />
              Admin
            </NavLink>
          )}
        </nav>

        <main className="app-main">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/my-drive" element={<MyDrive />} />
            <Route path="/recent" element={<WorkspaceViewPage view="recent" />} />
            <Route path="/starred" element={<WorkspaceViewPage view="starred" />} />
            <Route path="/shared-with-me" element={<WorkspaceViewPage view="shared" />} />
            <Route path="/shared-drives" element={<SharedDrives />} />
            <Route path="/collections" element={<Collections />} />
            <Route path="/duplicates" element={<Duplicates />} />
            <Route path="/links" element={<Links />} />
            <Route path="/trash" element={<Trash />} />
            <Route path="/schedules" element={<Schedules />} />
            <Route path="/quota" element={<Quota />} />
            <Route path="/uploads" element={<Uploads />} />
            <Route path="/account" element={<Account />} />
            <Route path="/developer" element={<Developer />} />
            <Route path="/developer/docs" element={<ApiDocs />} />
            <Route
              path="/admin"
              element={
                <RequireSuperadmin>
                  <Admin />
                </RequireSuperadmin>
              }
            />
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
    return <StatusScreen kind="offline" />;
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
