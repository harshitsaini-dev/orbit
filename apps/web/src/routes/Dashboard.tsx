import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PublicAccount } from '@orbit/shared-types';
import { ProviderIcon } from '../components/ProviderIcon.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { formatBytes } from '../lib/format.js';

function greeting(hour = new Date().getHours()): string {
  if (hour < 5) return 'Good night';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** What a signed-in user sees at the root: their own storage, not a pitch. */
export function Dashboard() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState<PublicAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<{ accounts: PublicAccount[] }>('/api/accounts', { signal: controller.signal })
      .then(({ accounts: rows }) => setAccounts(rows))
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setError('Could not load your accounts');
      });
    return () => controller.abort();
  }, []);

  const totalUsed = (accounts ?? []).reduce((sum, account) => sum + account.usedBytes, 0);
  // Only accounts that report an allowance can contribute to a total.
  const measured = (accounts ?? []).filter((account) => account.quotaBytes > 0);
  const totalQuota = measured.reduce((sum, account) => sum + account.quotaBytes, 0);
  const unmeasured = (accounts?.length ?? 0) - measured.length;

  const needsAttention = (accounts ?? []).filter((account) => account.status !== 'ok');

  return (
    <div style={{ display: 'grid', gap: '1.5rem' }}>
      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
        <h1 style={{ fontSize: 'clamp(1.4rem, 3.5vw, 1.9rem)' }}>
          {greeting()}
          {user?.displayName ? `, ${user.displayName.split(' ')[0]}` : ''}.
        </h1>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.4rem' }}>
          {accounts === null
            ? 'Loading your storage…'
            : accounts.length === 0
              ? 'No storage connected yet.'
              : `${formatBytes(totalUsed)} used across ${accounts.length} ${accounts.length === 1 ? 'account' : 'accounts'}${
                  totalQuota > 0 ? ` of ${formatBytes(totalQuota)}` : ''
                }.`}
        </p>

        {error && <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}

        {accounts !== null && accounts.length > 0 && totalQuota > 0 && (
          <div
            className="clay-sunken"
            style={{ height: 12, borderRadius: 'var(--radius-pill)', overflow: 'hidden', marginTop: '1rem' }}
            role="img"
            aria-label={`${formatBytes(totalUsed)} used of ${formatBytes(totalQuota)}`}
          >
            <div
              style={{
                width: `${Math.min(100, (totalUsed / totalQuota) * 100)}%`,
                minWidth: totalUsed > 0 ? 3 : 0,
                height: '100%',
                background: 'var(--accent)',
              }}
            />
          </div>
        )}

        {unmeasured > 0 && (
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: '0.6rem' }}>
            {unmeasured} {unmeasured === 1 ? 'account reports' : 'accounts report'} no allowance, so
            {unmeasured === 1 ? ' it is' : ' they are'} not in the total.
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: '1.25rem' }}>
          <Link
            to="/my-drive"
            className="clay-button clay-button--accent"
            style={{ padding: '0.5rem 1.2rem', fontSize: 14, textDecoration: 'none' }}
          >
            Browse files
          </Link>
          <Link
            to="/quota"
            className="clay-button"
            style={{ padding: '0.5rem 1.2rem', fontSize: 14, textDecoration: 'none' }}
          >
            {accounts?.length ? 'Manage accounts' : 'Connect an account'}
          </Link>
        </div>
      </section>

      {needsAttention.length > 0 && (
        <section
          className="clay"
          role="status"
          style={{ padding: 'clamp(1rem, 3vw, 1.5rem)', display: 'grid', gap: 8 }}
        >
          <strong style={{ color: 'var(--warning)' }}>Needs your attention</strong>
          {needsAttention.map((account) => (
            <span key={account.id} style={{ fontSize: 14, color: 'var(--text-muted)' }}>
              {account.nickname} —{' '}
              {account.status === 'needs_reauth'
                ? 'the connection expired and needs reconnecting.'
                : 'the provider could not be reached last time. It will retry on its own.'}
            </span>
          ))}
          <Link to="/quota" style={{ color: 'var(--accent)', fontSize: 14 }}>
            Open accounts
          </Link>
        </section>
      )}

      {accounts !== null && accounts.length > 0 && (
        <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
          <h2 style={{ fontSize: '1.1rem' }}>Your storage</h2>
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
            {accounts.map((account) => {
              const pct = account.quotaBytes > 0 ? (account.usedBytes / account.quotaBytes) * 100 : 0;
              return (
                <li key={account.id}>
                  {/* The whole card is the target. A separate "Open" link was
                      one more thing to aim at for no extra meaning. */}
                  <Link
                    to={`/my-drive?account=${encodeURIComponent(account.id)}&path=/`}
                    className="clay-sunken account-card"
                    style={{
                      padding: '0.95rem 1.05rem',
                      display: 'grid',
                      gap: 9,
                      textDecoration: 'none',
                      color: 'inherit',
                    }}
                  >
                    <span style={{ display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 }}>
                      <ProviderIcon provider={account.provider} size={24} />
                      <span
                        style={{
                          fontWeight: 600,
                          fontSize: 14,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {account.nickname}
                      </span>
                    </span>

                    {account.quotaBytes > 0 ? (
                      <>
                        <span
                          style={{
                            display: 'block',
                            height: 6,
                            borderRadius: 'var(--radius-pill)',
                            background: 'var(--surface)',
                            overflow: 'hidden',
                          }}
                        >
                          <span
                            style={{
                              display: 'block',
                              width: `${Math.min(100, pct)}%`,
                              minWidth: account.usedBytes > 0 ? 2 : 0,
                              height: '100%',
                              background: pct > 90 ? 'var(--danger)' : 'var(--accent)',
                            }}
                          />
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          {formatBytes(account.usedBytes)} of {formatBytes(account.quotaBytes)}
                        </span>
                      </>
                    ) : (
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {formatBytes(account.usedBytes)} stored · no reported limit
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {accounts !== null && accounts.length === 0 && (
        <section className="clay" style={{ padding: 'clamp(1.5rem, 4vw, 2.5rem)', display: 'grid', gap: '0.75rem' }}>
          <h2 style={{ fontSize: '1.1rem' }}>Nothing connected yet</h2>
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>
            Connect a cloud account and its files appear here. Orbit stores only an encrypted
            token — your files stay where they are.
          </p>
          <Link
            to="/quota"
            className="clay-button clay-button--accent"
            style={{ justifySelf: 'start', padding: '0.5rem 1.2rem', fontSize: 14, textDecoration: 'none' }}
          >
            Connect an account
          </Link>
        </section>
      )}
    </div>
  );
}
