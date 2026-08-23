import { useCallback, useEffect, useState } from 'react';
import { SCOPE_DESCRIPTIONS, type ApiScope } from '@orbit/shared-types';
import { ApiError, api } from '../lib/api.js';
import { ConfirmDialog } from './NameDialog.js';

/**
 * The other side of an application: what somebody has allowed, and taking it
 * back.
 *
 * This belongs on the account page rather than the developer one. Allowing an
 * app is something anybody might do; registering one is something a developer
 * does, and burying "who can read my files" behind a tab called Developer is
 * how people never find it.
 */

interface AllowedApp {
  grantId: string;
  appId: string;
  name: string;
  website: string | null;
  scopes: ApiScope[];
  lastUsedAt: string | null;
  createdAt: string;
}

function when(iso: string | null): string {
  if (!iso) return 'never used';

  const hours = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (hours < 1) return 'used just now';
  if (hours < 24) return `used ${Math.round(hours)}h ago`;
  return `used ${new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

export function AllowedApps() {
  const [apps, setApps] = useState<AllowedApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<AllowedApp | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api<{ apps: AllowedApp[] }>('/api/oauth/allowed');
      setApps(result.apps);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this');
      setApps([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(app: AllowedApp): Promise<void> {
    try {
      await api(`/api/oauth/allowed/${app.appId}`, { method: 'DELETE' });
      setRevoking(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not withdraw it');
    }
  }

  // Nothing to say when nobody has ever allowed anything, and a heading over an
  // empty box is a question somebody now has to answer for themselves.
  if (apps !== null && apps.length === 0 && !error) return null;

  return (
    <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
      <h2 style={{ fontSize: '1.1rem', margin: 0 }}>Applications you have allowed</h2>
      <p style={{ color: 'var(--text-muted)', margin: '0.4rem 0 0', fontSize: 13.5, lineHeight: 1.6 }}>
        Programs that can act on your drives without your password. Withdrawing takes effect
        immediately — anything the application still holds stops working.
      </p>

      {error && (
        <p role="alert" style={{ color: 'var(--danger)', margin: '0.8rem 0 0', fontSize: 13.5 }}>
          {error}
        </p>
      )}

      {apps && apps.length > 0 && (
        <ul className="webhook-list">
          {apps.map((app) => (
            <li key={app.grantId} className="webhook">
              <div className="webhook__head">
                <span className="webhook__name">
                  <strong>{app.name}</strong>
                  <span>
                    {app.website ?? 'No website given'} · {when(app.lastUsedAt)}
                  </span>
                </span>
              </div>

              <ul style={{ margin: 0, paddingLeft: '1.1rem', display: 'grid', gap: 3 }}>
                {app.scopes.map((scope) => (
                  <li key={scope} style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                    {SCOPE_DESCRIPTIONS[scope]}
                  </li>
                ))}
              </ul>

              <div className="webhook__actions">
                <button
                  type="button"
                  className="clay-button"
                  style={{ color: 'var(--danger)' }}
                  onClick={() => setRevoking(app)}
                >
                  Withdraw access
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {revoking && (
        <ConfirmDialog
          title={`Withdraw access from ${revoking.name}?`}
          description="It stops being able to reach your drives immediately. If you use it again, it will ask you to allow it once more."
          confirmLabel="Withdraw"
          destructive
          onConfirm={() => void revoke(revoking)}
          onClose={() => setRevoking(null)}
        />
      )}
    </section>
  );
}
