import { useEffect, useState } from 'react';
import type { OrbitFile } from '@orbit/shared-types';
import { ApiError, api } from '../lib/api.js';
import { Checkbox } from './Checkbox.js';
import { Modal } from './Modal.js';
import { Select } from './Select.js';

/**
 * Turning a file into a public link.
 *
 * The link points at Orbit and Orbit streams the bytes, so the provider's own
 * URL never leaves the server — which is the reason sharing had to be built
 * rather than delegated to each provider's own sharing feature.
 *
 * Opening the dialog does not create anything. A link is a public URL, and
 * making one as a side effect of curiosity is the kind of thing that ends with
 * a file being reachable that nobody meant to share.
 */

interface Share {
  shortId: string;
  url: string;
  name: string;
  permission: 'view' | 'download';
  hasPassword: boolean;
  expiresAt: string | null;
  accessCount: number;
  lastAccessedAt: string | null;
}

const EXPIRY_OPTIONS = [
  { value: '', label: 'Never expires' },
  { value: '1', label: 'After 1 day' },
  { value: '7', label: 'After 7 days' },
  { value: '30', label: 'After 30 days' },
];

export function ShareDialog({
  file,
  accountId,
  apiBase,
  onClose,
}: {
  file: OrbitFile;
  accountId: string;
  apiBase: string;
  onClose: () => void;
}) {
  const [existing, setExisting] = useState<Share | null | undefined>(undefined);
  const [allowDownload, setAllowDownload] = useState(true);
  const [expiry, setExpiry] = useState('');
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A link may already exist for this file; showing "create" over one that is
  // already public would be a lie. Asked for by account and remote id, not by
  // name - two files in different folders can share a name.
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ accountId, remoteId: file.remoteId });

    api<{ shares: Share[] }>(`/api/shares?${query.toString()}`, { signal: controller.signal })
      .then(({ shares }) => {
        const match = shares[0] ?? null;
        setExisting(match);
        if (match) {
          setAllowDownload(match.permission === 'download');
          setUsePassword(match.hasPassword);
        }
      })
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setExisting(null);
      });

    return () => controller.abort();
  }, [accountId, file.remoteId]);

  async function create(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const { share } = await api<{ share: Share }>('/api/shares', {
        method: 'POST',
        body: {
          accountId,
          remoteId: file.remoteId,
          permission: allowDownload ? 'download' : 'view',
          ...(expiry ? { expiresInDays: Number(expiry) } : {}),
          ...(usePassword && password ? { password } : {}),
        },
      });

      setExisting(share);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the link');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(): Promise<void> {
    if (!existing) return;
    setBusy(true);

    try {
      await api(`/api/shares/${existing.shortId}`, { method: 'DELETE' });
      setExisting(null);
      setPassword('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not revoke the link');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Share ${file.name}`}
      description="Anyone with the link can open it. The file stays where it is — Orbit streams it, and the provider's own address is never shared."
      onClose={onClose}
    >
      <div style={{ display: 'grid', gap: '0.9rem' }}>
        {existing === undefined && <p style={{ color: 'var(--text-muted)', margin: 0 }}>Checking…</p>}

        {existing === null && (
          <>
            <label className="share-row">
              <Checkbox
                checked={allowDownload}
                onChange={setAllowDownload}
                label="Allow downloading"
              />
            </label>
            <p className="share-hint">
              With this off, the file can be viewed in the page but not saved. It is a courtesy,
              not a lock: anything visible can be captured.
            </p>

            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Expiry</span>
              <Select value={expiry} onChange={setExpiry} options={EXPIRY_OPTIONS} label="Expiry" />
            </label>

            <label className="share-row">
              <Checkbox checked={usePassword} onChange={setUsePassword} label="Require a password" />
            </label>

            {usePassword && (
              <input
                type="password"
                className="clay-sunken"
                placeholder="Password for this link"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                style={{
                  border: 0,
                  padding: '0.65rem 0.9rem',
                  font: 'inherit',
                  color: 'var(--text)',
                  borderRadius: 'var(--radius-sm)',
                }}
              />
            )}
          </>
        )}

        {existing && (
          <>
            <div className="share-link">
              <input readOnly value={existing.url} aria-label="Share link" />
              <button
                type="button"
                className="clay-button clay-button--accent"
                onClick={() => {
                  void navigator.clipboard.writeText(existing.url).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1600);
                  });
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>

            <div className="share-qr">
              {/* Served by the API, which is also what the link points at. */}
              <img
                src={`${apiBase}/s/${existing.shortId}/qr`}
                alt={`QR code for the link to ${file.name}`}
                width={148}
                height={148}
              />
              <span>Scan to open on a phone</span>
            </div>

            <p className="share-hint">
              {existing.hasPassword ? 'Password protected. ' : ''}
              {existing.permission === 'download' ? 'Downloading allowed. ' : 'View only. '}
              {existing.expiresAt
                ? `Expires ${new Date(existing.expiresAt).toLocaleDateString()}. `
                : 'No expiry. '}
              {existing.accessCount === 0
                ? 'Not opened yet.'
                : `Opened ${existing.accessCount} ${existing.accessCount === 1 ? 'time' : 'times'}.`}
            </p>
          </>
        )}

        {error && (
          <p role="alert" style={{ color: 'var(--danger)', margin: 0, fontSize: 13.5 }}>
            {error}
          </p>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="clay-button" onClick={onClose} disabled={busy}>
            Close
          </button>

          {existing ? (
            <button
              type="button"
              className="clay-button"
              style={{ color: 'var(--danger)' }}
              onClick={() => void revoke()}
              disabled={busy}
            >
              Revoke link
            </button>
          ) : (
            <button
              type="button"
              className="clay-button clay-button--accent"
              onClick={() => void create()}
              disabled={busy || existing === undefined || (usePassword && !password)}
            >
              {busy ? 'Creating…' : 'Create link'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
