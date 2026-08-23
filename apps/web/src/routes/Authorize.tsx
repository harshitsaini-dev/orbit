import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { SCOPE_DESCRIPTIONS, type ApiScope } from '@orbit/shared-types';
import { BrandMark } from '../components/BrandMark.js';
import { ApiError, api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';

/**
 * The screen where somebody gives another program access to their drives.
 *
 * The most consequential page in Orbit, and written to be read rather than
 * clicked past: what is asking, what it will be able to do in the words the
 * rest of the app uses, and where the answer will be sent. Allow is not the
 * default focus and not the only styled button.
 *
 * Everything about the request was validated by the server before this page was
 * reached - an unregistered redirect, an unknown client or a missing PKCE
 * challenge is an error page, not a screen with an Allow button on it. What is
 * left here is the decision.
 */

interface AuthorizeRequest {
  app: {
    name: string;
    description: string | null;
    website: string | null;
    confidential: boolean;
  };
  scopes: ApiScope[];
  redirectUri: string;
}

export function Authorize() {
  const [params] = useSearchParams();
  const { user, loading } = useAuth();

  const [request, setRequest] = useState<AuthorizeRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const clientId = params.get('client_id') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';
  const scope = params.get('scope') ?? '';
  const challenge = params.get('code_challenge') ?? '';
  const state = params.get('state');

  useEffect(() => {
    if (!user) return;

    const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, scope });

    api<AuthorizeRequest>(`/api/oauth/request?${query.toString()}`)
      .then(setRequest)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : 'That request is not valid');
      });
  }, [user, clientId, redirectUri, scope]);

  async function decide(allow: boolean): Promise<void> {
    if (!allow) {
      /*
       * A refusal goes back to the app as an error, which is what the OAuth
       * specification says and what lets the app show "you cancelled" rather
       * than hanging on a callback that never arrives.
       */
      const target = new URL(redirectUri);
      target.searchParams.set('error', 'access_denied');
      if (state) target.searchParams.set('state', state);
      window.location.replace(target.toString());
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const { redirectTo } = await api<{ redirectTo: string }>('/api/oauth/consent', {
        method: 'POST',
        body: {
          client_id: clientId,
          redirect_uri: redirectUri,
          scope,
          code_challenge: challenge,
          ...(state ? { state } : {}),
        },
      });

      window.location.replace(redirectTo);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not complete that');
      setBusy(false);
    }
  }

  if (loading) return null;

  // Sent to sign in with the whole request kept, so it resumes here rather
  // than dropping somebody on the dashboard having lost what they were doing.
  if (!user) {
    const next = `${window.location.pathname}${window.location.search}`;
    return (
      <div className="legal">
        <main className="clay legal__sheet">
          <h1>Sign in first</h1>
          <p>An application is asking for access to your drives. Sign in to decide.</p>
          <p>
            <Link
              className="clay-button clay-button--accent"
              style={{ textDecoration: 'none' }}
              to={`/login?next=${encodeURIComponent(next)}`}
            >
              Sign in
            </Link>
          </p>
        </main>
      </div>
    );
  }

  return (
    <div className="legal">
      <header className="legal__head">
        <span className="legal__brand">
          <BrandMark size={26} />
          <span>Orbit</span>
        </span>
      </header>

      <main className="clay legal__sheet">
        {error && (
          <>
            <h1>That request is not valid</h1>
            <p role="alert">{error}</p>
            <p>
              <Link to="/">Back to Orbit</Link>
            </p>
          </>
        )}

        {!error && request && (
          <>
            <h1>
              Allow {request.app.name}?
            </h1>

            <p className="legal__lead">
              {request.app.description ??
                `${request.app.name} is asking to use your Orbit account.`}
            </p>

            <h2>It will be able to</h2>
            <ul>
              {request.scopes.map((scopeName) => (
                <li key={scopeName}>
                  <strong>{SCOPE_DESCRIPTIONS[scopeName]}</strong>
                  <br />
                  <code style={{ fontSize: 12 }}>{scopeName}</code>
                </li>
              ))}
            </ul>

            <h2>It will not be able to</h2>
            <p>
              See your password — Orbit has none to share. Change what it may do later without
              asking you again. Keep any of this once you take it back, which you can do at any
              time under <strong>Account</strong>.
            </p>

            <h2>Where the answer goes</h2>
            <p>
              <code style={{ overflowWrap: 'anywhere' }}>{request.redirectUri}</code>
              {request.app.website && (
                <>
                  <br />
                  <a href={request.app.website} target="_blank" rel="noreferrer noopener">
                    {request.app.website}
                  </a>
                </>
              )}
            </p>

            {!request.app.confidential && (
              <p className="share-hint" style={{ margin: 0 }}>
                This is an app that runs on your own device, so it holds no secret of its own.
                That is normal for a phone or desktop application.
              </p>
            )}

            <div
              style={{
                display: 'flex',
                gap: 10,
                flexWrap: 'wrap',
                marginTop: '1.25rem',
                paddingTop: '1rem',
                borderTop: '1px solid var(--border)',
              }}
            >
              <button
                type="button"
                className="clay-button"
                disabled={busy}
                onClick={() => void decide(false)}
              >
                Cancel
              </button>

              <button
                type="button"
                className="clay-button clay-button--accent"
                disabled={busy}
                onClick={() => void decide(true)}
              >
                {busy ? 'Allowing…' : `Allow ${request.app.name}`}
              </button>
            </div>

            <p className="share-hint" style={{ marginTop: '0.9rem' }}>
              Signed in as {user.email}. Only allow an application you recognise.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
