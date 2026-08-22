import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { catalogueEntry } from '@orbit/shared-types';
import type { CatalogueEntry, PublicAccount } from '@orbit/shared-types';
import { DriveMembers, levelLabel } from '../components/DriveMembers.js';
import { ConnectDialog } from '../components/ConnectDialog.js';
import { forgetAccount } from '../lib/cache.js';
import { ProviderIcon } from '../components/ProviderIcon.js';
import { ConfirmDialog } from '../components/NameDialog.js';
import { AccountCardsSkeleton } from '../components/Skeleton.js';
import { StatusScreen, statusKindFor } from '../components/StatusScreen.js';
import { StorageBar } from '../components/StorageBar.js';
import { StorageGroups } from '../components/StorageGroups.js';
import { api, ApiError } from '../lib/api.js';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

export function Quota() {
  const [params, setParams] = useSearchParams();
  const [accounts, setAccounts] = useState<PublicAccount[] | null>(null);
  const [connectable, setConnectable] = useState<CatalogueEntry[]>([]);
  // Kept apart on purpose: failing to load the page and failing to disconnect
  // one account are different sizes of problem, and turning the second into a
  // full-page screen would throw away everything the user could still see.
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<PublicAccount | null>(null);
  const [connecting, setConnecting] = useState<CatalogueEntry | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ accounts: rows }, { entries }] = await Promise.all([
        api<{ accounts: PublicAccount[] }>('/api/accounts'),
        api<{ entries: CatalogueEntry[] }>('/api/connectable'),
      ]);
      setAccounts(rows);
      setConnectable(entries);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err : new Error('Could not load accounts'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadError && accounts === null) {
    return (
      <StatusScreen
        kind={loadError instanceof ApiError ? statusKindFor(loadError.status) : 'server-error'}
        onRetry={() => void load()}
      />
    );
  }

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
      // Its folders would otherwise stay browsable from the cache after the
      // account it came from is gone.
      await forgetAccount(account.id);
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
        <h1 className="page-title">Connect an account</h1>
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
          {connectable.map((entry) => {
            const face = (
              <>
                <ProviderIcon provider={entry.key} size={28} />
                <span style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                  <span>{entry.label}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 400 }}>{entry.blurb}</span>
                </span>
              </>
            );

            const shared = {
              className: 'clay-button',
              style: {
                display: 'flex',
                gap: 12,
                alignItems: 'center',
                textDecoration: 'none',
                textAlign: 'left' as const,
                width: '100%',
                // Filling the row rather than sizing to the blurb: one provider
                // needs two lines to describe and the next needs one, and cards
                // of three different heights read as a broken layout rather
                // than as descriptions of different lengths.
                height: '100%',
              },
            };

            return (
              <li key={entry.key} style={{ display: 'grid' }}>
                {/* A store with fields to fill in stays in the app; an OAuth
                    provider has to leave it, which needs a real navigation. */}
                {entry.fields?.length ? (
                  <button type="button" {...shared} onClick={() => setConnecting(entry)}>
                    {face}
                  </button>
                ) : (
                  <a {...shared} href={`${API_BASE}/auth/connect/${entry.provider}`}>
                    {face}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: '1rem' }}>
          More providers arrive as their adapters land. See Home for the full list.
        </p>

        {connecting && (
          <ConnectDialog
            entry={connecting}
            onClose={() => setConnecting(null)}
            onConnected={() => {
              setConnecting(null);
              void load();
            }}
          />
        )}
      </section>

      <StorageGroups />

      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
        <h2 style={{ fontSize: '1.1rem' }}>Connected accounts</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.4rem' }}>
          Orbit holds only an encrypted token for each account. Your files stay where they are.
        </p>

        {error && <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
        {!accounts && !error && (
          <div style={{ marginTop: '1.25rem' }}>
            <AccountCardsSkeleton cards={1} />
          </div>
        )}

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
                    <ProviderIcon provider={account.catalogueKey ?? account.provider} size={30} />
                    <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                      <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {account.nickname}
                      </strong>
                      <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                        {/* The catalogue's name, not the adapter's id: five entries run on
                            the s3 adapter, so "s3" names a Supabase bucket and a
                            Backblaze one identically. */}
                        {catalogueEntry(account.catalogueKey ?? '')?.label ??
                          account.provider.replace(/_/g, ' ')}
                        {account.status === 'needs_reauth' && ' · needs reconnecting'}
                        {/* Whose drive this is, and how far they may go with it -
                            the difference between an upload button that works and
                            one that always fails. */}
                        {!account.isOwner && ` · shared with you · ${levelLabel(account.accessLevel)}`}
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
                    {/* Somebody else's connection is not theirs to sever, however
                        far their access on it goes. */}
                    {account.isOwner && (
                    <button
                      type="button"
                      className="clay-button"
                      style={{ padding: '0.35rem 0.9rem', fontSize: 13, color: 'var(--danger)' }}
                      disabled={busyId === account.id}
                      onClick={() => setDisconnecting(account)}
                    >
                      Disconnect
                    </button>
                    )}
                  </div>
                </div>
                <StorageBar account={account} />

                {/* Only where there is anybody to manage: an admin guest sees
                    this too, an ordinary guest is not told it exists. */}
                {(account.isOwner || account.accessLevel === 'admin') && (
                  <DriveMembers account={account} />
                )}
              </li>
            ))}
          </ul>
        )}
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
