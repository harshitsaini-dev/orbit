import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { CatalogueEntry, PublicAccount } from '@orbit/shared-types';
import { ProviderIcon } from '../components/ProviderIcon.js';
import { ConfirmDialog } from '../components/NameDialog.js';
import { StorageBar } from '../components/StorageBar.js';
import { api, ApiError } from '../lib/api.js';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

export function Quota() {
  const [params, setParams] = useSearchParams();
  const [accounts, setAccounts] = useState<PublicAccount[] | null>(null);
  const [connectable, setConnectable] = useState<CatalogueEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<PublicAccount | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ accounts: rows }, { entries }] = await Promise.all([
        api<{ accounts: PublicAccount[] }>('/api/accounts'),
        api<{ entries: CatalogueEntry[] }>('/api/connectable'),
      ]);
      setAccounts(rows);
      setConnectable(entries);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load accounts');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connectOutcome = params.get('connect');
  const connectReason = params.get('reason');

  function dismissOutcome() {
    params.delete('connect');
    params.delete('reason');
    setParams(params, { replace: true });
  }

  async function disconnect(account: PublicAccount) {
    setBusyId(account.id);
    try {
      await api(`/api/accounts/${account.id}`, { method: 'DELETE' });
      setDisconnecting(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not disconnect');
    } finally {
      setBusyId(null);
    }
  }

  async function refresh(account: PublicAccount) {
    setBusyId(account.id);
    try {
      await api(`/api/accounts/${account.id}/refresh-quota`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'needs_reauth'
          ? `${account.nickname} needs reconnecting.`
          : 'Could not refresh the quota',
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ display: 'grid', gap: '1.5rem' }}>
      {connectOutcome && (
        <div
          className="clay"
          role="status"
          style={{
            padding: '1rem 1.25rem',
            display: 'flex',
            justifyContent: 'space-between',
            gap: '1rem',
            alignItems: 'center',
            color: connectOutcome === 'connected' ? 'var(--success)' : 'var(--danger)',
          }}
        >
          <span>
            {connectOutcome === 'connected'
              ? 'Account connected.'
              : `Could not connect${connectReason ? `: ${connectReason.replace(/_/g, ' ')}` : ''}.`}
          </span>
          <button type="button" className="clay-button" style={{ padding: '0.3rem 0.9rem', fontSize: 13 }} onClick={dismissOutcome}>
            Dismiss
          </button>
        </div>
      )}

      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
        <h1 style={{ fontSize: '1.4rem' }}>Connected accounts</h1>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.4rem' }}>
          Orbit holds only an encrypted token for each account. Your files stay where they are.
        </p>

        {error && <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
        {!accounts && !error && <p style={{ color: 'var(--text-muted)' }}>Loading…</p>}

        {accounts?.length === 0 && (
          <p style={{ color: 'var(--text-muted)', marginTop: '1rem' }}>
            No accounts yet. Connect one below to get started.
          </p>
        )}

        {accounts && accounts.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: '1.25rem 0 0', display: 'grid', gap: 12 }}>
            {accounts.map((account) => (
              <li key={account.id} className="clay-sunken" style={{ padding: '1rem 1.15rem', display: 'grid', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', minWidth: 0 }}>
                    <ProviderIcon provider={account.provider} size={30} />
                    <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                      <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {account.nickname}
                      </strong>
                      <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                        {account.provider.replace(/_/g, ' ')}
                        {account.status === 'needs_reauth' && ' · needs reconnecting'}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="clay-button"
                      style={{ padding: '0.35rem 0.9rem', fontSize: 13 }}
                      disabled={busyId === account.id}
                      onClick={() => void refresh(account)}
                    >
                      Refresh
                    </button>
                    <button
                      type="button"
                      className="clay-button"
                      style={{ padding: '0.35rem 0.9rem', fontSize: 13, color: 'var(--danger)' }}
                      disabled={busyId === account.id}
                      onClick={() => setDisconnecting(account)}
                    >
                      Disconnect
                    </button>
                  </div>
                </div>
                <StorageBar account={account} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
        <h2 style={{ fontSize: '1.1rem' }}>Connect an account</h2>
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: '1rem 0 0',
            display: 'grid',
            gap: 10,
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          }}
        >
          {connectable.map((entry) => (
            <li key={entry.key}>
              {/* A full navigation, not fetch: the OAuth flow has to leave the app. */}
              <a
                href={`${API_BASE}/auth/connect/${entry.provider}`}
                className="clay-button"
                style={{
                  display: 'flex',
                  gap: 12,
                  alignItems: 'center',
                  textDecoration: 'none',
                  textAlign: 'left',
                  width: '100%',
                }}
              >
                <ProviderIcon provider={entry.key} size={28} />
                <span style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                  <span>{entry.label}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 400 }}>{entry.blurb}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: '1rem' }}>
          More providers arrive in Phase 3. See Home for the full list.
        </p>
      </section>

      {disconnecting && (
        <ConfirmDialog
          title={`Disconnect ${disconnecting.nickname}?`}
          description="Orbit forgets its stored token. Nothing in the account itself is touched, and it can be reconnected at any time."
          confirmLabel="Disconnect"
          destructive
          busy={busyId === disconnecting.id}
          onConfirm={() => void disconnect(disconnecting)}
          onClose={() => setDisconnecting(null)}
        />
      )}
    </div>
  );
}
