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

  /*
   * Providers this instance cannot connect yet.
   *
   * An OAuth client belongs to whoever runs Orbit, so a provider can be built
   * and tested and still unusable here until its keys are registered. Listing
   * it as an ordinary card would be a button that ends at the provider's own
   * error page; leaving it out entirely would lose the answer to "will Orbit
   * ever do X". So it is shown, and marked.
   */
  const [comingSoon, setComingSoon] = useState<CatalogueEntry[]>([]);

  /*
   * Which accounts to show, once there are enough of them to look for one.
   *
   * Ten connections is a page you scroll to find the one you came for, and
   * three of them are the same Gmail address on different services - so the
   * filter searches the provider's name as well as the nickname. Typing
   * "dropbox" is a reasonable way to ask for the Dropbox one.
   */
  const [accountFilter, setAccountFilter] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(false);

  /** A connection that will not work until somebody does something about it. */
  const needsAttention = (account: PublicAccount): boolean =>
    account.status === 'needs_reauth' || account.status === 'error';

  const problems = (accounts ?? []).filter(needsAttention).length;

  const shownAccounts = (accounts ?? []).filter((account) => {
    if (onlyProblems && !needsAttention(account)) return false;

    const needle = accountFilter.trim().toLowerCase();
    if (!needle) return true;

    // The service's name as well as the nickname: several accounts here are
    // the same address on different providers, so "dropbox" is a reasonable
    // way to ask for one of them.
    const service = catalogueEntry(account.catalogueKey ?? '')?.label ?? account.provider;

    return (
      account.nickname.toLowerCase().includes(needle) ||
      service.toLowerCase().includes(needle)
    );
  });
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
      const [{ accounts: rows }, { entries }, { entries: everything }] = await Promise.all([
        api<{ accounts: PublicAccount[] }>('/api/accounts'),
        api<{ entries: CatalogueEntry[] }>('/api/connectable'),
        api<{ entries: CatalogueEntry[] }>('/api/catalogue'),
      ]);

      setAccounts(rows);
      setConnectable(entries);
      setComingSoon(everything.filter((entry) => entry.configured === false));
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

        {comingSoon.length > 0 && (
          <>
            <h2 style={{ fontSize: '0.95rem', margin: '1.5rem 0 0.2rem' }}>Not set up yet</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '0 0 0.75rem', lineHeight: 1.6 }}>
              Built and working, but this Orbit has no application registered with them. Whoever
              runs it adds the keys and they appear above — nothing here needs rebuilding.
            </p>

            <ul className="provider-soon-list">
              {comingSoon.map((entry) => (
                <li key={entry.key} className="clay-sunken">
                  <ProviderIcon provider={entry.key} size={24} />
                  <span>
                    <strong>
                      {entry.label}
                      <span className="provider-soon">Coming soon</span>
                    </strong>
                    <span>{entry.blurb}</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
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

        {/*
          * Only once the list is long enough to search. A filter box above two
          * accounts is a control that costs a line and answers a question
          * nobody had.
          */}
        {accounts && accounts.length > 3 && (
          <div className="account-filter">
            <input
              className="clay-sunken account-filter__box"
              type="search"
              placeholder={`Filter ${accounts.length} accounts…`}
              aria-label="Filter accounts"
              value={accountFilter}
              onChange={(event) => setAccountFilter(event.target.value)}
            />

            {/*
              * The one filter worth a button of its own. "Which of these needs
              * my attention" is the question somebody opens this page with, and
              * it is otherwise answered by reading every card.
              */}
            {problems > 0 && (
              <button
                type="button"
                className="clay-button"
                aria-pressed={onlyProblems}
                onClick={() => setOnlyProblems((on) => !on)}
                style={{
                  whiteSpace: 'nowrap',
                  ...(onlyProblems ? { boxShadow: 'var(--shadow-clay-inset)' } : {}),
                }}
              >
                Needs attention ({problems})
              </button>
            )}
          </div>
        )}

        {accounts && accounts.length > 0 && shownAccounts.length === 0 && (
          <p style={{ color: 'var(--text-muted)', marginTop: '1rem', fontSize: 13.5 }}>
            No account matches that.
          </p>
        )}

        {accounts && accounts.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: '1.25rem 0 0', display: 'grid', gap: 12 }}>
            {shownAccounts.map((account) => (
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
