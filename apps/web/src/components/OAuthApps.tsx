import { useCallback, useEffect, useState } from 'react';
import { API_SCOPES, SCOPE_DESCRIPTIONS, type ApiScope } from '@orbit/shared-types';
import { ApiError, api } from '../lib/api.js';
import { Checkbox } from './Checkbox.js';
import { DialogActions, Modal } from './Modal.js';
import { ConfirmDialog } from './NameDialog.js';

/**
 * Applications somebody has registered, for other people to sign in to.
 *
 * The step past a personal access token. A token is a credential its owner
 * pastes into their own script; an application is how a program asks *another*
 * person for access, and the difference shows up in what has to be registered
 * in advance - the exact addresses an authorisation may be sent back to, and
 * the most it may ever ask for.
 */

interface OAuthApp {
  id: string;
  name: string;
  description: string | null;
  website: string | null;
  clientId: string;
  confidential: boolean;
  redirectUris: string[];
  scopes: ApiScope[];
  createdAt: string;
}

const API_BASE = import.meta.env.VITE_API_URL ?? '';

export function OAuthApps() {
  const [apps, setApps] = useState<OAuthApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<{ secret: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<OAuthApp | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api<{ apps: OAuthApp[] }>('/api/oauth/apps');
      setApps(result.apps);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load applications');
      setApps([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function rotate(app: OAuthApp): Promise<void> {
    try {
      const { secret } = await api<{ secret: string }>(`/api/oauth/apps/${app.id}/rotate`, {
        method: 'POST',
      });
      setIssued({ secret, name: app.name });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not rotate the secret');
    }
  }

  async function remove(app: OAuthApp): Promise<void> {
    try {
      await api(`/api/oauth/apps/${app.id}`, { method: 'DELETE' });
      setRemoving(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove it');
    }
  }

  return (
    <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
          <h2 style={{ fontSize: '1.1rem', margin: 0 }}>Applications</h2>
          <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
            For a program other people sign in to. They allow it on an Orbit screen and never give
            it a password — a token is the thing to use for a script of your own.
          </p>
        </div>

        <span style={{ flex: 1 }} />

        <button
          type="button"
          className="clay-button clay-button--accent"
          onClick={() => setCreating(true)}
        >
          Register an application
        </button>
      </div>

      {error && (
        <p role="alert" style={{ color: 'var(--danger)', margin: '0.8rem 0 0', fontSize: 13.5 }}>
          {error}
        </p>
      )}

      {apps?.length === 0 && (
        <p style={{ color: 'var(--text-muted)', margin: '1rem 0 0', fontSize: 13.5 }}>
          None yet. An application needs its redirect addresses registered in advance; they are
          matched exactly, because a prefix match is how a stolen authorisation code happens.
        </p>
      )}

      {apps && apps.length > 0 && (
        <ul className="webhook-list">
          {apps.map((app) => (
            <li key={app.id} className="webhook">
              <div className="webhook__head">
                <span className="webhook__name">
                  <strong>{app.name}</strong>
                  <span>{app.description ?? app.website ?? 'No description'}</span>
                </span>

                <span
                  className="webhook__state"
                  data-state={app.confidential ? 'on' : 'off'}
                  title={
                    app.confidential
                      ? 'Holds a secret — a server-side application'
                      : 'Holds no secret — a phone or desktop app, proving itself with PKCE'
                  }
                >
                  {app.confidential ? 'Confidential' : 'Public'}
                </span>
              </div>

              <p className="webhook__events">
                <code>{app.clientId}</code>
              </p>

              <p className="webhook__meta">
                {app.scopes.join(' · ')}
                <br />
                {app.redirectUris.join(' · ')}
              </p>

              <div className="webhook__actions">
                <button
                  type="button"
                  className="clay-button"
                  onClick={() => {
                    void navigator.clipboard.writeText(app.clientId).then(() => {
                      setCopied(app.id);
                      setTimeout(() => setCopied(null), 1600);
                    });
                  }}
                >
                  {copied === app.id ? 'Copied' : 'Copy client id'}
                </button>

                {app.confidential && (
                  <button
                    type="button"
                    className="clay-button"
                    title="The old secret stops working immediately"
                    onClick={() => void rotate(app)}
                  >
                    New secret
                  </button>
                )}

                <button
                  type="button"
                  className="clay-button"
                  style={{ color: 'var(--danger)' }}
                  onClick={() => setRemoving(app)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {apps && apps.length > 0 && (
        <>
          <h3 style={{ fontSize: '0.95rem', margin: '1.25rem 0 0.4rem' }}>Sending somebody here</h3>
          <pre className="token-example">
            <code>{`${API_BASE || 'http://localhost:8787'}/oauth/authorize
  ?response_type=code
  &client_id=<your client id>
  &redirect_uri=<one you registered, exactly>
  &scope=files:read files:download
  &code_challenge=<base64url(sha256(verifier))>
  &code_challenge_method=S256
  &state=<your own value>`}</code>
          </pre>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '0.4rem 0 0', lineHeight: 1.6 }}>
            PKCE is required rather than optional. Exchange the code at{' '}
            <code>POST /oauth/token</code> with <code>grant_type=authorization_code</code> and the
            verifier; you get an access token good for an hour and a refresh token that rotates
            every time it is used.
          </p>
        </>
      )}

      {creating && (
        <RegisterApp
          onClose={() => setCreating(false)}
          onCreated={(secret, name) => {
            setCreating(false);
            if (secret) setIssued({ secret, name });
            void load();
          }}
        />
      )}

      {issued && (
        <Modal title="Copy it now" onClose={() => setIssued(null)}>
          <p style={{ margin: 0, lineHeight: 1.6 }}>
            This is the only time the client secret for <strong>{issued.name}</strong> is shown.
            Orbit keeps a hash of it, not the secret — if it is lost, make a new one here.
          </p>

          <code className="token-issued">{issued.secret}</code>

          <DialogActions>
            <button
              type="button"
              className="clay-button clay-button--accent"
              onClick={() => {
                void navigator.clipboard.writeText(issued.secret).then(() => setCopied('secret'));
              }}
            >
              {copied === 'secret' ? 'Copied' : 'Copy secret'}
            </button>
            <button type="button" className="clay-button" onClick={() => setIssued(null)}>
              Done
            </button>
          </DialogActions>
        </Modal>
      )}

      {removing && (
        <ConfirmDialog
          title="Remove this application?"
          description={`Everyone who allowed "${removing.name}" loses access immediately, and its client id stops working. This cannot be undone.`}
          confirmLabel="Remove"
          destructive
          onConfirm={() => void remove(removing)}
          onClose={() => setRemoving(null)}
        />
      )}
    </section>
  );
}

function RegisterApp({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (secret: string | null, name: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [website, setWebsite] = useState('');
  const [redirects, setRedirects] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>([]);
  const [confidential, setConfidential] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const { secret } = await api<{ secret: string | null }>('/api/oauth/apps', {
        method: 'POST',
        body: {
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(website.trim() ? { website: website.trim() } : {}),
          redirectUris: redirects
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
          scopes,
          confidential,
        },
      });

      onCreated(secret, name.trim());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not register it');
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Register an application"
      description="What other people will see when it asks them for access."
      onClose={onClose}
    >
      <div style={{ display: 'grid', gap: '0.9rem' }}>
        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Name</span>
          <input
            className="clay-sunken webhook__field"
            placeholder="Shown on the consent screen"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>What it does</span>
          <input
            className="clay-sunken webhook__field"
            placeholder="One line, also on the consent screen"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>

        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Website</span>
          <input
            className="clay-sunken webhook__field"
            placeholder="https://example.com"
            value={website}
            onChange={(event) => setWebsite(event.target.value)}
          />
        </label>

        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Redirect addresses</span>
          <textarea
            className="clay-sunken webhook__field"
            rows={3}
            placeholder={'https://example.com/callback\nhttp://127.0.0.1:7777/callback'}
            value={redirects}
            onChange={(event) => setRedirects(event.target.value)}
          />
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            One per line, matched exactly. https, or http on localhost for a desktop app.
          </span>
        </label>

        <div style={{ display: 'grid', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>The most it may ever ask for</span>

          {API_SCOPES.map((scope) => (
            <Checkbox
              key={scope}
              checked={scopes.includes(scope)}
              onChange={(on) =>
                setScopes((current) =>
                  on ? [...current, scope] : current.filter((s) => s !== scope),
                )
              }
              label={
                <span style={{ display: 'grid', gap: 2 }}>
                  <code style={{ fontSize: 12.5 }}>{scope}</code>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {SCOPE_DESCRIPTIONS[scope]}
                  </span>
                </span>
              }
            />
          ))}
        </div>

        <Checkbox
          checked={confidential}
          onChange={setConfidential}
          label={
            <span style={{ display: 'grid', gap: 2 }}>
              <span style={{ fontSize: 13 }}>It runs on a server and can keep a secret</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Turn this off for a phone, desktop or single-page app. Shipping a secret to one
                only means shipping it to everybody; PKCE is what proves those instead.
              </span>
            </span>
          }
        />

        {error && (
          <p role="alert" style={{ color: 'var(--danger)', margin: 0, fontSize: 13.5 }}>
            {error}
          </p>
        )}

        <DialogActions>
          <button type="button" className="clay-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="clay-button clay-button--accent"
            disabled={busy || !name.trim() || !redirects.trim() || scopes.length === 0}
            onClick={() => void submit()}
          >
            {busy ? 'Registering…' : 'Register'}
          </button>
        </DialogActions>
      </div>
    </Modal>
  );
}
