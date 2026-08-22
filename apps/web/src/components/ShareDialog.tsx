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
 *
 * Several files at once get several links, not one link to a bundle: Orbit
 * stores no bytes of its own, so there is nowhere to build an archive, and a
 * link per file is also what someone wants when they are sending three files
 * to three different people.
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
  files,
  accountId,
  apiBase,
  onClose,
}: {
  /** Everything being shared. One set of settings covers all of it. */
  files: OrbitFile[];
  accountId: string;
  apiBase: string;
  onClose: () => void;
}) {
  const many = files.length > 1;
  const [links, setLinks] = useState<Share[]>([]);
  const [checked, setChecked] = useState(false);
  const [allowDownload, setAllowDownload] = useState(true);
  const [expiry, setExpiry] = useState('');
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  // Which link's Copy button just said so, or 'all' for the whole list.
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * A link may already exist for this file; showing "create" over one that is
   * already public would be a lie. Asked for by account and remote id, not by
   * name - two files in different folders can share a name.
   *
   * Only worth doing for a single file. Looking up a selection of forty would
   * be forty requests to decide the wording of one button, and the answer
   * would be a mixture anyway; creating simply adds a second link to anything
   * already shared, which the Links page lists and can revoke.
   */
  const only = many ? undefined : files[0];

  useEffect(() => {
    if (!only) {
      setChecked(true);
      return;
    }

    const controller = new AbortController();
    const query = new URLSearchParams({ accountId, remoteId: only.remoteId });

    api<{ shares: Share[] }>(`/api/shares?${query.toString()}`, { signal: controller.signal })
      .then(({ shares }) => {
        const match = shares[0];
        setChecked(true);
        if (match) {
          setLinks([match]);
          setAllowDownload(match.permission === 'download');
          setUsePassword(match.hasPassword);
        }
      })
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setChecked(true);
      });

    return () => controller.abort();
  }, [accountId, only]);

  async function create(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const made: Share[] = [];

      for (const file of files) {
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

        made.push(share);
      }

      setLinks(made);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the link');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(): Promise<void> {
    if (links.length === 0) return;
    setBusy(true);

    try {
      for (const link of links) {
        await api(`/api/shares/${link.shortId}`, { method: 'DELETE' });
      }

      setLinks([]);
      setPassword('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not revoke the link');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={many ? `Share ${files.length} items` : `Share ${files[0]?.name ?? ''}`}
      description="Anyone with the link can open it. The file stays where it is — Orbit streams it, and the provider's own address is never shared."
      onClose={onClose}
    >
      <div style={{ display: 'grid', gap: '0.9rem' }}>
        {!checked && <p style={{ color: 'var(--text-muted)', margin: 0 }}>Checking…</p>}

        {checked && links.length === 0 && (
          <>
            <div className="share-row">
              <Checkbox
                checked={allowDownload}
                onChange={setAllowDownload}
                label="Allow downloading"
              />
            </div>
            <p className="share-hint">
              With this off, the file can be viewed in the page but not saved. It is a courtesy,
              not a lock: anything visible can be captured.
            </p>

            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Expiry</span>
              <Select value={expiry} onChange={setExpiry} options={EXPIRY_OPTIONS} label="Expiry" />
            </label>

            <div className="share-row">
              <Checkbox checked={usePassword} onChange={setUsePassword} label="Require a password" />
            </div>

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

        {links.length > 0 && (
          <>
            {links.map((link) => (
              <div className="share-link" key={link.shortId}>
                <input readOnly value={link.url} aria-label={`Link to ${link.name}`} />
                <button
                  type="button"
                  className="clay-button clay-button--accent"
                  onClick={() => {
                    void navigator.clipboard.writeText(link.url).then(() => {
                      setCopied(link.shortId);
                      setTimeout(() => setCopied(null), 1600);
                    });
                  }}
                >
                  {copied === link.shortId ? 'Copied' : 'Copy'}
                </button>
              </div>
            ))}

            {/* One code is scannable; a wall of them is not, so a set of links
                is offered as text to paste somewhere instead. */}
            {!many && links[0] ? (
              <div className="share-qr">
                {/* Served by the API, which is also what the link points at. */}
                <img
                  src={`${apiBase}/s/${links[0].shortId}/qr`}
                  alt={`QR code for the link to ${links[0].name}`}
                  width={148}
                  height={148}
                />
                <span>Scan to open on a phone</span>
              </div>
            ) : (
              <button
                type="button"
                className="clay-button"
                onClick={() => {
                  const text = links.map((link) => `${link.name}\n${link.url}`).join('\n\n');
                  void navigator.clipboard.writeText(text).then(() => {
                    setCopied('all');
                    setTimeout(() => setCopied(null), 1600);
                  });
                }}
              >
                {copied === 'all' ? 'All copied' : 'Copy every link'}
              </button>
            )}

            <p className="share-hint">
              {links[0]?.hasPassword ? 'Password protected. ' : ''}
              {links[0]?.permission === 'download' ? 'Downloading allowed. ' : 'View only. '}
              {links[0]?.expiresAt
                ? `Expires ${new Date(links[0].expiresAt).toLocaleDateString()}. `
                : 'No expiry. '}
              {many
                ? `${links.length} links, one per file.`
                : links[0]?.accessCount === 0
                  ? 'Not opened yet.'
                  : `Opened ${links[0]?.accessCount} ${
                      links[0]?.accessCount === 1 ? 'time' : 'times'
                    }.`}
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

          {links.length > 0 ? (
            <button
              type="button"
              className="clay-button"
              style={{ color: 'var(--danger)' }}
              onClick={() => void revoke()}
              disabled={busy}
            >
              {many ? `Revoke ${links.length} links` : 'Revoke link'}
            </button>
          ) : (
            <button
              type="button"
              className="clay-button clay-button--accent"
              onClick={() => void create()}
              disabled={busy || !checked || (usePassword && !password)}
            >
              {busy ? 'Creating…' : many ? `Create ${files.length} links` : 'Create link'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
