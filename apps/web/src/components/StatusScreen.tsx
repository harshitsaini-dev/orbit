import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { BrandMark } from './BrandMark.js';

export type StatusKind = 'offline' | 'not-found' | 'server-error' | 'denied';

/**
 * The screens for the four ways a page can fail to be the page.
 *
 * Each one says what happened, whether it is the visitor's doing, and what to
 * try next. A dead end with no way out is the thing to avoid: every screen
 * offers at least one action, and the retry is a real retry rather than a
 * reload, so an offline visitor who reconnects keeps their place.
 */
interface Copy {
  title: string;
  body: string;
  glyph: ReactNode;
  tone: 'muted' | 'danger';
}

const COPY: Record<StatusKind, Copy> = {
  offline: {
    title: 'You are offline',
    body:
      'Orbit streams your files straight from the accounts they live in, so it needs a connection to show anything. This page will come back on its own once you are online again.',
    glyph: <OfflineGlyph />,
    tone: 'muted',
  },
  'not-found': {
    title: 'That page does not exist',
    body:
      'The address may be mistyped, or it may point at something that has since been moved or disconnected.',
    glyph: <NotFoundGlyph />,
    tone: 'muted',
  },
  'server-error': {
    title: 'Something broke on our side',
    body:
      'This one is not your doing. Nothing was lost — your files are untouched in the accounts they live in. Trying again often works, since the usual cause is a provider that was briefly unreachable.',
    glyph: <ServerGlyph />,
    tone: 'danger',
  },
  denied: {
    title: 'You do not have access to this',
    body:
      'Either the session has expired, or this belongs to someone else. Signing in again is usually enough.',
    glyph: <DeniedGlyph />,
    tone: 'muted',
  },
};

interface Props {
  kind: StatusKind;
  /** Overrides the stock explanation - use it when the cause is actually known. */
  detail?: string | undefined;
  /** Shown when there is something worth retrying without a full reload. */
  onRetry?: (() => void) | undefined;
}

/**
 * Always the whole viewport, never a panel inside the workspace.
 *
 * A page that failed to load is not one of several things on screen - it is
 * what happened. Drawn in the content area beside a working sidebar it reads as
 * one broken widget, and people click past it; drawn as the screen it reads as
 * the state the app is actually in, which is the true one.
 *
 * Rendered through a portal because most of these are returned from a page
 * component, which sits inside the shell - so covering the viewport from there
 * would still leave the header and the navigation drawn around it. The portal
 * is what makes "the whole screen" true from anywhere rather than only at the
 * top of the tree.
 *
 * That is also why the brand mark is here rather than only when signed out:
 * covering the viewport takes the header with it, and a full-screen message
 * with nothing identifying it could have come from anywhere.
 */
export function StatusScreen({ kind, detail, onRetry }: Props) {
  const copy = COPY[kind];

  return createPortal(
    <div className="status-shell">
      <section
        className="clay status-screen"
        role={kind === 'not-found' ? undefined : 'alert'}
        data-status={kind}
        style={{ margin: 'auto', maxWidth: 560 }}
      >
        <span className="status-screen__brand">
          <BrandMark size={26} />
          <strong>Orbit</strong>
        </span>

        <span
          className={`status-screen__glyph status-screen__glyph--${copy.tone}`}
          aria-hidden="true"
        >
          {copy.glyph}
        </span>

        <h1>{copy.title}</h1>
        <p>{detail ?? copy.body}</p>

        <div className="status-screen__actions">
          {onRetry && (
            <button type="button" className="clay-button clay-button--accent" onClick={onRetry}>
              Try again
            </button>
          )}

          {kind === 'denied' ? (
            <Link to="/login" className="clay-button">
              Sign in
            </Link>
          ) : (
            <Link to="/" className="clay-button">
              Back to your workspace
            </Link>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}

/**
 * Maps a failed request onto the screen that explains it.
 *
 * `online` decides what a request that never reached the server means: with no
 * network it is the visitor's connection, and with one it is Orbit that is not
 * answering. Blaming the wrong side sends people to restart a router that was
 * working fine.
 */
export function statusKindFor(status: number, online: boolean = navigator.onLine): StatusKind {
  if (status === 0) return online ? 'server-error' : 'offline';
  if (status === 401 || status === 403) return 'denied';
  if (status === 404) return 'not-found';
  // 4xx that is none of the above is a bad request rather than a missing page,
  // and there is nothing the visitor can do about it either way.
  return 'server-error';
}

// --- glyphs ---------------------------------------------------------------

const glyph = {
  viewBox: '0 0 48 48',
  width: 44,
  height: 44,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  style: { display: 'block' },
} as const;

function OfflineGlyph() {
  return (
    <svg {...glyph}>
      <path d="M6.5 18.5a26 26 0 0 1 10-6" />
      <path d="M41.5 18.5a26 26 0 0 0-10-6" />
      <path d="M13.5 26a17 17 0 0 1 6-3.8" />
      <path d="M34.5 26a17 17 0 0 0-6-3.8" />
      <path d="M20 33.4a8 8 0 0 1 8 0" />
      <circle cx="24" cy="39.5" r="1.4" fill="currentColor" stroke="none" />
      <path d="M8 8l32 32" />
    </svg>
  );
}

function NotFoundGlyph() {
  return (
    <svg {...glyph}>
      <circle cx="24" cy="24" r="17" />
      <path d="M24 15.5v10" />
      <circle cx="24" cy="32" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ServerGlyph() {
  return (
    <svg {...glyph}>
      <rect x="8" y="10" width="32" height="12" rx="3" />
      <rect x="8" y="26" width="32" height="12" rx="3" />
      <path d="M14.5 16h.02M14.5 32h.02" />
      <path d="M31 14.5l6 6M37 14.5l-6 6" />
    </svg>
  );
}

function DeniedGlyph() {
  return (
    <svg {...glyph}>
      <rect x="11" y="21" width="26" height="17" rx="3.5" />
      <path d="M17 21v-5a7 7 0 0 1 14 0v5" />
      <circle cx="24" cy="29.5" r="1.8" fill="currentColor" stroke="none" />
    </svg>
  );
}
