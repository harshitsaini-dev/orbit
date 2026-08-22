import { useEffect, useState } from 'react';
import { catalogueEntry, type OrbitFile, type PublicAccount } from '@orbit/shared-types';
import { ApiError, api } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';
import { Checkbox } from './Checkbox.js';
import { Modal } from './Modal.js';
import { ProviderIcon } from './ProviderIcon.js';

/**
 * Sending a file to a different cloud.
 *
 * The two things worth saying plainly are said: the bytes go through Orbit
 * rather than through this browser, and a move deletes the original only once
 * the copy has landed. Both are the sort of thing people want to know before
 * they trust it with something they cannot get back.
 */

export function TransferDialog({
  file,
  fromAccountId,
  accounts,
  onClose,
  onQueued,
}: {
  file: OrbitFile;
  fromAccountId: string;
  accounts: PublicAccount[];
  onClose: () => void;
  onQueued: () => void;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const [move, setMove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Everything except where it already is, and anything too full to take it.
  const options = accounts.filter((account) => {
    if (account.id === fromAccountId) return false;
    if (account.status !== 'ok') return false;
    if (account.quotaBytes <= 0) return true;
    return account.quotaBytes - account.usedBytes >= file.sizeBytes;
  });

  const blocked = accounts.filter(
    (account) =>
      account.id !== fromAccountId &&
      account.status === 'ok' &&
      account.quotaBytes > 0 &&
      account.quotaBytes - account.usedBytes < file.sizeBytes,
  );

  useEffect(() => {
    setTarget((current) => current ?? options[0]?.id ?? null);
  }, [options]);

  async function start(): Promise<void> {
    if (!target) return;
    setBusy(true);
    setError(null);

    try {
      await api('/api/transfers', {
        method: 'POST',
        body: {
          sourceAccountId: fromAccountId,
          sourceRemoteId: file.remoteId,
          targetAccountId: target,
          targetPath: '/',
          deleteSource: move,
        },
      });
      onQueued();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the transfer');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Send ${file.name} to another cloud`}
      description="Orbit streams the file between the two providers. It does not pass through this browser, and nothing is stored on Orbit's own disk."
      onClose={onClose}
    >
      <div style={{ display: 'grid', gap: '0.9rem' }}>
        {options.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: 13.5, lineHeight: 1.55 }}>
            {accounts.length <= 1
              ? 'Only one account is connected, so there is nowhere to send it. Connect another under Quota.'
              : `No other connected account has ${formatBytes(file.sizeBytes)} free.`}
          </p>
        ) : (
          <>
            <ul className="transfer-targets">
              {options.map((account) => (
                <li key={account.id}>
                  <label>
                    <input
                      type="radio"
                      name="transfer-target"
                      checked={target === account.id}
                      onChange={() => setTarget(account.id)}
                    />
                    <ProviderIcon provider={account.catalogueKey ?? account.provider} size={18} />
                    <span>
                      <strong>{account.nickname}</strong>
                      <span>
                        {catalogueEntry(account.catalogueKey ?? '')?.label ?? account.provider}
                        {account.quotaBytes > 0
                          ? ` · ${formatBytes(account.quotaBytes - account.usedBytes)} free`
                          : ' · no limit reported'}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>

            {blocked.length > 0 && (
              <p className="share-hint">
                {blocked.length} other {blocked.length === 1 ? 'account has' : 'accounts have'} too
                little room for this file.
              </p>
            )}

            <label className="share-row">
              <Checkbox checked={move} onChange={setMove} label="Delete the original afterwards" />
            </label>
            <p className="share-hint">
              {move
                ? 'The original is deleted only once the copy has landed. If the copy fails, nothing is removed.'
                : 'The file is copied. The original stays where it is.'}
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
            Cancel
          </button>
          <button
            type="button"
            className="clay-button clay-button--accent"
            onClick={() => void start()}
            disabled={busy || !target}
          >
            {busy ? 'Starting…' : move ? 'Move' : 'Copy'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
