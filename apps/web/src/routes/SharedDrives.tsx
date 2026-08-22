import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { catalogueEntry, type OrbitFile, type PublicAccount } from '@orbit/shared-types';
import { ProviderIcon } from '../components/ProviderIcon.js';
import { StatusScreen, statusKindFor } from '../components/StatusScreen.js';
import { ApiError, api } from '../lib/api.js';

/**
 * Drives that belong to an organisation rather than to a person.
 *
 * Given a page of their own for the reason they are confusing anywhere else: a
 * shared drive is not in anybody's My Drive and does not count against
 * anybody's allowance. Google bills it to the organisation and reports it under
 * a quota of its own, so a team drive listed among somebody's personal folders
 * gets three separate things wrong - who owns it, who else can see it, and
 * whose storage it fills.
 *
 * Orbit's mirror deliberately excludes them for the same reason, which is why
 * this page browses the provider directly rather than reading the index.
 */

interface Drive {
  account: PublicAccount;
  file: OrbitFile;
}

export function SharedDrives() {
  const [drives, setDrives] = useState<Drive[] | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    try {
      const { accounts } = await api<{ accounts: PublicAccount[] }>('/api/accounts');

      // Only Drive has the concept. Asking the others would be a request each
      // to be told no.
      const candidates = accounts.filter((account) => account.provider === 'google_drive');

      const found = await Promise.all(
        candidates.map(async (account) => {
          const query = new URLSearchParams({ accountId: account.id, path: '/Shared drives' });

          try {
            const page = await api<{ files: OrbitFile[] }>(`/api/files?${query.toString()}`);
            return page.files.map((file) => ({ account, file }));
          } catch {
            // An account with none answers 404 for that folder, which is not
            // an error worth showing - it is the ordinary case.
            return [];
          }
        }),
      );

      setDrives(found.flat());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Could not look for shared drives'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && drives === null) {
    return (
      <StatusScreen
        kind={error instanceof ApiError ? statusKindFor(error.status) : 'server-error'}
        onRetry={() => void load()}
      />
    );
  }

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
        <h1 style={{ fontSize: '1.4rem', margin: 0 }}>Shared drives</h1>
        <p style={{ color: 'var(--text-muted)', margin: '0.4rem 0 0', lineHeight: 1.6 }}>
          Drives that belong to an organisation rather than to you. They are{' '}
          <strong>not part of your own storage</strong> — the organisation is billed for them and
          they have a quota of their own, so nothing here counts against the allowance on your
          account.
        </p>
      </section>

      {drives?.length === 0 && (
        <section
          className="clay"
          style={{ padding: 'clamp(1.5rem, 4vw, 2.5rem)', textAlign: 'center' }}
        >
          <p style={{ color: 'var(--text-muted)', margin: 0, lineHeight: 1.6 }}>
            None of your connected accounts is a member of a shared drive. Being given a folder
            inside one does not make you a member — that arrives under{' '}
            <Link to="/shared-with-me" style={{ color: 'var(--accent)' }}>
              Shared with me
            </Link>{' '}
            instead.
          </p>
        </section>
      )}

      {drives && drives.length > 0 && (
        <ul className="collection-grid">
          {drives.map(({ account, file }) => (
            <li key={`${account.id}:${file.remoteId}`}>
              <Link
                to={`/my-drive?account=${encodeURIComponent(account.id)}&path=${encodeURIComponent(file.virtualPath)}`}
              >
                <span className="collection-card__icon">
                  <ProviderIcon provider={account.catalogueKey ?? account.provider} size={22} />
                </span>

                <span className="collection-card__name">{file.name}</span>

                <span className="collection-card__meta">
                  {catalogueEntry(account.catalogueKey ?? '')?.label ?? account.provider} ·{' '}
                  {account.nickname}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
