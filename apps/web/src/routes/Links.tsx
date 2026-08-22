import { useCallback, useEffect, useState } from 'react';
import { catalogueEntry, type PublicAccount } from '@orbit/shared-types';
import { FileIcon } from '../components/FileIcon.js';
import { FilterBox, useFileFilter } from '../components/ListControls.js';
import { ConfirmDialog } from '../components/NameDialog.js';
import { ProviderIcon } from '../components/ProviderIcon.js';
import { FileListSkeleton } from '../components/Skeleton.js';
import { StatusScreen, statusKindFor } from '../components/StatusScreen.js';
import { ApiError, api } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';

/**
 * Every file this account has published, in one place.
 *
 * A link put on the open internet is the least undoable thing Orbit does, and
 * until now the only way to find one was to remember which file it was and open
 * that file's dialog. Somebody who cannot list what they have published cannot
 * really be said to be in control of it.
 *
 * So the page is built around revoking rather than around browsing: what each
 * link allows, whether it has a password, when it expires, how often it has
 * been opened, and one button to take it away.
 */

interface Share {
  shortId: string;
  url: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  accountId: string;
  permission: 'view' | 'download';
  hasPassword: boolean;
  expiresAt: string | null;
  accessCount: number;
  createdAt: string;
  /** Set once the file behind it can no longer be found. */
  missing?: boolean;
}

function expiry(iso: string | null): { text: string; gone: boolean } {
  if (!iso) return { text: 'No expiry', gone: false };

  const at = new Date(iso);
  const days = (at.getTime() - Date.now()) / 86_400_000;

  if (days < 0) return { text: 'Expired', gone: true };
  if (days < 1) return { text: 'Expires today', gone: false };
  return { text: `Expires in ${Math.round(days)}d`, gone: false };
}

export function Links() {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [accounts, setAccounts] = useState<PublicAccount[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [revoking, setRevoking] = useState<Share | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [links, drives] = await Promise.all([
        api<{ shares: Share[] }>('/api/shares'),
        api<{ accounts: PublicAccount[] }>('/api/accounts'),
      ]);

      setShares(links.shares);
      setAccounts(drives.accounts);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Could not load your links'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // `virtualPath` is what the shared filter searches alongside the name; a link
  // has no path, so the drive it came from stands in for one.
  const searchable = (shares ?? []).map((share) => ({
    ...share,
    virtualPath: accounts.find((account) => account.id === share.accountId)?.nickname ?? '',
  }));

  const { filter, setFilter, shown } = useFileFilter(searchable);

  async function revoke(share: Share): Promise<void> {
    // Optimistic: the link stops working the moment the server agrees, and
    // leaving the row up while that happens reads as nothing having happened.
    setShares((current) => current?.filter((row) => row.shortId !== share.shortId) ?? null);
    setRevoking(null);

    try {
      await api(`/api/shares/${share.shortId}`, { method: 'DELETE' });
    } catch {
      setNotice('Could not revoke that link');
      await load();
    }
  }

  async function copy(share: Share): Promise<void> {
    try {
      await navigator.clipboard.writeText(share.url);
      setCopied(share.shortId);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setNotice('Could not copy — the address is in the row, to select by hand');
    }
  }

  if (error && shares === null) {
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
        <h1 style={{ fontSize: '1.4rem', margin: 0 }}>Links</h1>
        <p style={{ color: 'var(--text-muted)', margin: '0.4rem 0 0', lineHeight: 1.6 }}>
          {shares === null
            ? 'Reading what you have published…'
            : shares.length === 0
              ? 'Nothing is published. A link you create from a file appears here so you can take it away again.'
              : `${shares.length} ${shares.length === 1 ? 'file is' : 'files are'} reachable by anyone holding the link. Revoking one stops it immediately.`}
        </p>

        <FilterBox
          value={filter}
          onChange={setFilter}
          count={shares?.length ?? 0}
          noun="links"
        />
      </section>

      {notice && (
        <p role="alert" className="clay" style={{ padding: '0.8rem 1.1rem', margin: 0, color: 'var(--danger)' }}>
          {notice}
        </p>
      )}

      {shares === null && (
        <section className="clay" style={{ padding: '0.75rem' }}>
          <FileListSkeleton rows={4} />
        </section>
      )}

      {shown.length > 0 && (
        <ul className="link-list">
          {shown.map((share) => {
            const account = accounts.find((entry) => entry.id === share.accountId);
            const life = expiry(share.expiresAt);

            return (
              <li key={share.shortId} className="clay">
                <FileIcon
                  name={share.name}
                  mimeType={share.mimeType}
                  isFolder={false}
                  size={26}
                />

                <span className="link-list__what">
                  <strong>{share.name}</strong>
                  <span>
                    {formatBytes(share.sizeBytes)}
                    {account && (
                      <>
                        {' · '}
                        <ProviderIcon
                          provider={account.catalogueKey ?? account.provider}
                          size={13}
                        />{' '}
                        {catalogueEntry(account.catalogueKey ?? '')?.label ?? account.provider} ·{' '}
                        {account.nickname}
                      </>
                    )}
                  </span>
                </span>

                <span className="link-list__terms">
                  {/* What the link actually permits, which is the thing worth
                      checking before deciding whether to keep it. */}
                  <span>{share.permission === 'download' ? 'Download allowed' : 'View only'}</span>
                  <span>{share.hasPassword ? 'Password' : 'No password'}</span>
                  <span data-expired={life.gone ? '' : undefined}>{life.text}</span>
                  <span>
                    {share.accessCount === 0
                      ? 'Not opened yet'
                      : `Opened ${share.accessCount} ${share.accessCount === 1 ? 'time' : 'times'}`}
                  </span>
                </span>

                <span className="link-list__actions">
                  <button type="button" className="clay-button" onClick={() => void copy(share)}>
                    {copied === share.shortId ? 'Copied' : 'Copy'}
                  </button>
                  <a
                    className="clay-button"
                    href={share.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open
                  </a>
                  <button
                    type="button"
                    className="clay-button"
                    style={{ color: 'var(--danger)' }}
                    onClick={() => setRevoking(share)}
                  >
                    Revoke
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {shares !== null && shares.length > 0 && shown.length === 0 && (
        <section className="clay" style={{ padding: '1.25rem', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>
            No link matches “{filter}”.
          </p>
        </section>
      )}

      {revoking && (
        <ConfirmDialog
          title={`Revoke the link to “${revoking.name}”?`}
          description="The address stops working straight away, for everybody holding it. The file itself is untouched, and you can publish a new link later — it will be a different address."
          confirmLabel="Revoke link"
          destructive
          onConfirm={() => void revoke(revoking)}
          onClose={() => setRevoking(null)}
        />
      )}
    </div>
  );
}
