import { useEffect, useState } from 'react';
import {
  CATEGORY_LABELS,
  catalogueEntry,
  categorise,
  type OrbitFile,
  type PublicAccount,
} from '@orbit/shared-types';
import { api } from '../lib/api.js';
import { EXIF_HEAD_BYTES, readExif, type ExifData } from '../lib/exif.js';
import { formatBytes } from '../lib/format.js';
import { previewKindFor } from '../lib/preview.js';
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

const API_BASE = import.meta.env.VITE_API_URL ?? '';

/**
 * What a photograph says about itself.
 *
 * Read from the file's first stretch of bytes over a Range request - EXIF sits
 * at the front of a JPEG, so this costs a couple of hundred kilobytes whatever
 * the photo weighs, and nothing at all for a file that has none.
 */
function usePhotoDetails(file: OrbitFile, accountId: string | undefined): ExifData | null {
  const [exif, setExif] = useState<ExifData | null>(null);

  useEffect(() => {
    setExif(null);
    if (!accountId || file.isFolder || previewKindFor(file) !== 'image') return;

    const controller = new AbortController();
    const query = new URLSearchParams({ accountId });
    const url = `${API_BASE}/api/files/${encodeURIComponent(file.remoteId)}/content?${query.toString()}`;

    fetch(url, {
      credentials: 'include',
      signal: controller.signal,
      headers: { range: `bytes=0-${EXIF_HEAD_BYTES - 1}` },
    })
      .then((response) => (response.ok ? response.arrayBuffer() : null))
      .then((bytes) => {
        if (bytes) setExif(readExif(bytes));
      })
      // A photo whose details cannot be read is a photo with no details, not an
      // error worth putting on a panel about something else.
      .catch(() => undefined);

    return () => controller.abort();
  }, [file, accountId]);

  return exif;
}

/** "28.605, 77.225" - and a link only if somebody chooses to follow it. */
function GpsRow({ latitude, longitude }: { latitude: number; longitude: number }) {
  return (
    <span className="details__gps">
      <code>
        {latitude}, {longitude}
      </code>
      {/*
        A link rather than an embedded map. Embedding one would send this
        person's coordinates to a mapping service the moment the panel opened;
        following a link is their decision, and noreferrer keeps Orbit out of
        what that service is told.
      */}
      <a
        href={`https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=15/${latitude}/${longitude}`}
        target="_blank"
        rel="noreferrer noopener"
      >
        Open in a map
      </a>
      <span className="details__caution">
        This is where the photo was taken. Anyone you send the file to gets it too.
      </span>
    </span>
  );
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
  const exif = usePhotoDetails(file, account?.id);

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

          {exif && (
            <>
              {(exif.make || exif.model) && (
                <Row label="Camera">{[exif.make, exif.model].filter(Boolean).join(' ')}</Row>
              )}
              {exif.lens && <Row label="Lens">{exif.lens}</Row>}
              {exif.takenAt && <Row label="Taken">{exif.takenAt}</Row>}

              {(exif.exposureTime || exif.fNumber || exif.iso || exif.focalLength) && (
                <Row label="Exposure">
                  {[
                    exif.exposureTime,
                    exif.fNumber && `f/${exif.fNumber}`,
                    exif.iso && `ISO ${exif.iso}`,
                    exif.focalLength && `${exif.focalLength}mm`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Row>
              )}

              {exif.widthPx && exif.heightPx && (
                <Row label="Dimensions">
                  {exif.widthPx} × {exif.heightPx}
                </Row>
              )}

              {exif.software && <Row label="Software">{exif.software}</Row>}

              {exif.gps && (
                <Row label="Location">
                  <GpsRow latitude={exif.gps.latitude} longitude={exif.gps.longitude} />
                </Row>
              )}
            </>
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
