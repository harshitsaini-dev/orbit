import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  API_SCOPES,
  SCOPE_DESCRIPTIONS,
  type ApiScope,
  type PublicApiToken,
} from '@orbit/shared-types';
import { Checkbox } from '../components/Checkbox.js';
import { DialogActions, Modal } from '../components/Modal.js';
import { ConfirmDialog } from '../components/NameDialog.js';
import { Select } from '../components/Select.js';
import { FileListSkeleton } from '../components/Skeleton.js';
import { StatusScreen, statusKindFor } from '../components/StatusScreen.js';
import { ApiError, api } from '../lib/api.js';

/**
 * Personal access tokens: Orbit from a script.
 *
 * The page is built around two facts that a token list has to make impossible
 * to miss. The value exists exactly once, on creation - so it is shown on its
 * own, loudly, with copying as the obvious next action. And a token is a
 * standing grant, so the list leads with what each one may do and how recently
 * anything used it, which are the two things that decide whether to revoke it.
 */

const API_BASE = import.meta.env.VITE_API_URL ?? '';

/** What the expiry choice offers. A token with no expiry outlives its purpose. */
const EXPIRIES: Array<{ value: string; label: string }> = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: 'A year' },
  { value: '', label: 'No expiry' },
];

function when(iso: string | null): string {
  if (!iso) return 'Never used';

  const days = (Date.now() - new Date(iso).getTime()) / 86_400_000;
  if (days < 1) return 'Used today';
  if (days < 2) return 'Used yesterday';
  return `Used ${Math.round(days)} days ago`;
}

function expiry(iso: string | null): string {
  if (!iso) return 'No expiry';

  const days = (new Date(iso).getTime() - Date.now()) / 86_400_000;
  if (days < 0) return 'Expired';
  if (days < 1) return 'Expires today';
  return `Expires in ${Math.round(days)}d`;
}

export function Developer() {
  const [tokens, setTokens] = useState<PublicApiToken[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<PublicApiToken | null>(null);
  const [issued, setIssued] = useState<{ token: string; name: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const { tokens: rows } = await api<{ tokens: PublicApiToken[] }>('/api/tokens');
      setTokens(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Could not load your tokens'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(token: PublicApiToken): Promise<void> {
    // Optimistic: the token stops working the moment the server agrees, and
    // leaving the row up while that happens reads as nothing having happened.
    setTokens((current) => current?.filter((row) => row.id !== token.id) ?? null);
    setRevoking(null);

    try {
      await api(`/api/tokens/${token.id}`, { method: 'DELETE' });
    } catch {
      setNotice('Could not revoke that token');
      await load();
    }
  }

  if (error && tokens === null) {
    return (
      <StatusScreen
        kind={error instanceof ApiError ? statusKindFor(error.status) : 'server-error'}
        onRetry={() => void load()}
      />
    );
  }

  return (
    <div className="developer-page">
      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
        <h1 style={{ fontSize: '1.4rem', margin: 0 }}>Developer</h1>
        <p style={{ color: 'var(--text-muted)', margin: '0.4rem 0 0', lineHeight: 1.6 }}>
          A personal access token lets a script reach your drives through Orbit&apos;s API — every
          provider you have connected, behind one interface. Orbit proxies the bytes, so a token
          never exposes the Google or Dropbox credentials underneath.
        </p>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: '1rem' }}>
          <button
            type="button"
            className="clay-button clay-button--accent"
            style={{ padding: '0.5rem 1.2rem', fontSize: 14 }}
            onClick={() => setCreating(true)}
          >
            New token
          </button>

          <Link
            to="/developer/docs"
            className="clay-button"
            style={{ padding: '0.5rem 1.2rem', fontSize: 14, textDecoration: 'none' }}
          >
            API documentation
          </Link>
        </div>
      </section>

      {notice && (
        <div className="clay" style={{ padding: '0.8rem 1rem', color: 'var(--danger)' }}>
          {notice}
        </div>
      )}

      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
        <h2 style={{ fontSize: '1.1rem', margin: 0 }}>Your tokens</h2>

        {tokens === null ? (
          <div style={{ marginTop: '1rem' }}>
            <FileListSkeleton rows={3} />
          </div>
        ) : tokens.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', marginTop: '0.6rem' }}>
            None yet. A token you create is shown once and cannot be recovered afterwards.
          </p>
        ) : (
          <ul className="token-list">
            {tokens.map((token) => (
              <li key={token.id} className="clay-sunken token-row">
                <div style={{ minWidth: 0, display: 'grid', gap: 4 }}>
                  <strong>{token.name}</strong>
                  <code style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>
                    orbit_pat_…{token.tail}
                  </code>
                  <span className="token-scopes">
                    {token.scopes.map((scope) => (
                      <span key={scope}>{scope}</span>
                    ))}
                  </span>
                </div>

                <span style={{ color: 'var(--text-muted)', fontSize: 12.5, textAlign: 'right' }}>
                  {when(token.lastUsedAt)}
                  <br />
                  {expiry(token.expiresAt)}
                </span>

                <button
                  type="button"
                  className="clay-button"
                  style={{ padding: '0.35rem 0.9rem', fontSize: 13 }}
                  onClick={() => setRevoking(token)}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
        <h2 style={{ fontSize: '1.1rem', margin: 0 }}>Using it</h2>
        <p style={{ color: 'var(--text-muted)', margin: '0.4rem 0 0.8rem', lineHeight: 1.6 }}>
          Send the token as a bearer credential. Everything lives under <code>/v1</code>, and the{' '}
          <Link to="/developer/docs">API documentation</Link> lists every endpoint with its scopes
          and a request you can paste.
        </p>

        <pre className="token-example">
          <code>{`curl -H "Authorization: Bearer orbit_pat_…" \\
  ${API_BASE || 'http://localhost:8787'}/v1/accounts

curl -H "Authorization: Bearer orbit_pat_…" \\
  "${API_BASE || 'http://localhost:8787'}/v1/files?accountId=<id>&path=/"`}</code>
        </pre>
      </section>

      {creating && (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={(token, name) => {
            setCreating(false);
            setIssued({ token, name });
            void load();
          }}
        />
      )}

      {issued && (
        <Modal title="Copy it now" onClose={() => setIssued(null)}>
          <p style={{ margin: 0, lineHeight: 1.6 }}>
            This is the only time <strong>{issued.name}</strong> is readable. Orbit stores a
            fingerprint of it, not the token, so it cannot be shown again — if it is lost, revoke
            it and make another.
          </p>

          <code className="token-issued">{issued.token}</code>

          <DialogActions>
            <button
              type="button"
              className="clay-button clay-button--accent"
              onClick={() => {
                navigator.clipboard
                  .writeText(issued.token)
                  .then(() => setCopied(true))
                  .catch(() => setNotice('Could not copy — select the token above by hand'));
              }}
            >
              {copied ? 'Copied' : 'Copy token'}
            </button>
            <button type="button" className="clay-button" onClick={() => setIssued(null)}>
              Done
            </button>
          </DialogActions>
        </Modal>
      )}

      {revoking && (
        <ConfirmDialog
          title="Revoke this token?"
          description={`Anything using "${revoking.name}" stops working immediately. This cannot be undone.`}
          confirmLabel="Revoke"
          destructive
          onConfirm={() => void revoke(revoking)}
          onClose={() => setRevoking(null)}
        />
      )}
    </div>
  );
}

function CreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (token: string, name: string) => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>(['files:read']);
  const [days, setDays] = useState('90');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(scope: ApiScope): void {
    setScopes((current) =>
      current.includes(scope) ? current.filter((one) => one !== scope) : [...current, scope],
    );
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const { token } = await api<{ token: string }>('/api/tokens', {
        method: 'POST',
        body: {
          name: name.trim(),
          scopes,
          ...(days ? { expiresInDays: Number(days) } : {}),
        },
      });

      onCreated(token, name.trim());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create that token');
      setBusy(false);
    }
  }

  return (
    <Modal title="New token" onClose={onClose}>
      <label className="field">
        <span>Name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="backup script"
          maxLength={80}
        />
        <span className="field__help">
          For you, so two tokens can be told apart later. It is not sent anywhere.
        </span>
      </label>

      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontSize: 13, fontWeight: 600, padding: 0 }}>What it may do</legend>
        <span className="field__help" style={{ marginBottom: '0.5rem' }}>
          Grant the least that works. A token cannot create another token, whatever it holds.
        </span>

        <div className="scope-grid">
          {API_SCOPES.map((scope) => (
            <Checkbox
              key={scope}
              checked={scopes.includes(scope)}
              onChange={() => toggle(scope)}
              label={
                <span style={{ display: 'grid', gap: 1 }}>
                  <code style={{ fontSize: 12.5 }}>{scope}</code>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                    {SCOPE_DESCRIPTIONS[scope]}
                  </span>
                </span>
              }
            />
          ))}
        </div>
      </fieldset>

      <label className="field">
        <span>Expires</span>
        <Select value={days} onChange={setDays} options={EXPIRIES} label="Expires" />
      </label>

      {error && <p style={{ color: 'var(--danger)', margin: 0 }}>{error}</p>}

      <DialogActions>
        <button
          type="button"
          className="clay-button clay-button--accent"
          disabled={busy || name.trim().length === 0 || scopes.length === 0}
          onClick={() => void submit()}
        >
          {busy ? 'Creating…' : 'Create token'}
        </button>
        <button type="button" className="clay-button" onClick={onClose}>
          Cancel
        </button>
      </DialogActions>
    </Modal>
  );
}
