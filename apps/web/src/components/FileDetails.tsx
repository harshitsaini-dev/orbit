import { useEffect, useState } from 'react';
import {
  CATEGORY_LABELS,
  catalogueEntry,
  categorise,
  type OrbitFile,
  type PublicAccount,
} from '@orbit/shared-types';
import { api } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';
import { FileIcon } from './FileIcon.js';
import { Modal } from './Modal.js';
import { ProviderIcon } from './ProviderIcon.js';

/**
 * Everything Orbit knows about one file.
 *
 * The point is the last two rows. The rest — size, kind, when it changed — is
 * visible in the listing already; where a file actually lives, and whether
 * anyone outside can reach it, is not visible anywhere, and it is the thing
 * people open a details panel to find out.
 */

interface Props {
  file: OrbitFile;
  account: PublicAccount | undefined;
  onClose: () => void;
}

interface ShareLink {
  shortId: string;
  url: string;
  /** `view` or `download` - whether the link lets somebody save the file. */
  permission: 'view' | 'download';
  expiresAt: string | null;
  accessCount: number;
}

function when(iso: string | undefined): string {
  if (!iso) return 'Not reported';

  const date = new Date(iso);
  // Providers use the epoch for "no idea", and 1970 is never the answer
  // somebody wanted.
  if (Number.isNaN(date.getTime()) || date.getFullYear() < 1980) return 'Not reported';

  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="details__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function FileDetails({ file, account, onClose }: Props) {
  const [shares, setShares] = useState<ShareLink[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    // Asked per file rather than read from a list: whether this one is
    // published is the question, and the answer has to be current.
    const query = new URLSearchParams({ accountId: account?.id ?? '', remoteId: file.remoteId });

    api<{ shares: ShareLink[] }>(`/api/shares?${query.toString()}`, { signal: controller.signal })
      .then(({ shares: rows }) => setShares(rows))
      .catch(() => setShares([]));

    return () => controller.abort();
  }, [account?.id, file.remoteId]);

  const category = categorise(file.mimeType, file.name);
  const folder = file.virtualPath.slice(0, file.virtualPath.lastIndexOf('/')) || '/';

  return (
    <Modal title="Details" onClose={onClose}>
      <div className="details">
        <div className="details__head">
          <FileIcon
            name={file.name}
            mimeType={file.mimeType}
            isFolder={file.isFolder}
            size={34}
          />
          <div>
            <strong>{file.name}</strong>
            <span>
              {file.isFolder ? 'Folder' : CATEGORY_LABELS[category]}
              {!file.isFolder && ` · ${formatBytes(file.sizeBytes)}`}
            </span>
          </div>
        </div>

        <dl className="details__list">
          {!file.isFolder && <Row label="Size">{formatBytes(file.sizeBytes)}</Row>}
          <Row label="Kind">{file.isFolder ? 'Folder' : CATEGORY_LABELS[category]}</Row>
          <Row label="Type">
            {/* The provider's own answer, which is often nothing useful - an
                object store labels almost everything octet-stream. Shown as it
                is rather than dressed up. */}
            <code>{file.mimeType || 'unknown'}</code>
          </Row>
          <Row label="Modified">{when(file.modifiedAt)}</Row>

          <Row label="Where">
            {account ? (
              <span className="details__where">
                <ProviderIcon provider={account.catalogueKey ?? account.provider} size={15} />
                <span>
                  {catalogueEntry(account.catalogueKey ?? '')?.label ?? account.provider} ·{' '}
                  {account.nickname}
                </span>
              </span>
            ) : (
              'Unknown account'
            )}
          </Row>

          <Row label="Folder">
            <code>{folder}</code>
          </Row>

          {file.checksum && (
            <Row label="Checksum">
              {/* The thing that lets the duplicate finder say "identical"
                  rather than "probably". Worth being able to read. */}
              <code className="details__checksum">{file.checksum}</code>
            </Row>
          )}

          <Row label="Shared externally">
            {shares === null ? (
              'Checking…'
            ) : shares.length === 0 ? (
              'No link. Only you can reach this through Orbit.'
            ) : (
              <span className="details__shares">
                {shares.map((share) => (
                  <span key={share.shortId}>
                    <strong>/s/{share.shortId}</strong>
                    <span>
                      {share.permission === 'download' ? 'download allowed' : 'view only'} ·{' '}
                      {share.expiresAt ? `expires ${when(share.expiresAt)}` : 'no expiry'} ·{' '}
                      {share.accessCount} {share.accessCount === 1 ? 'view' : 'views'}
                    </span>
                  </span>
                ))}
              </span>
            )}
          </Row>
        </dl>

        <p className="share-hint" style={{ margin: 0 }}>
          Orbit stores none of this file. Everything here is read from{' '}
          {account ? catalogueEntry(account.catalogueKey ?? '')?.label ?? account.provider : 'the provider'}{' '}
          when you ask for it.
        </p>
      </div>
    </Modal>
  );
}
