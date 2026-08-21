import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatBytes } from '../lib/format.js';
import { useUploads, type UploadJob } from '../lib/uploads.js';

/**
 * The header's upload button, and the panel behind it.
 *
 * Modelled on how a browser shows downloads: a small persistent control that
 * says how much is left, and a list you open when you want the detail. The
 * queue used to be a panel inside My Drive, which meant it was invisible
 * everywhere else and the only way to check on an upload was to navigate back
 * to the folder that started it.
 *
 * It appears only when there is something to report. A control that is always
 * there and usually says nothing is just furniture.
 */
export function UploadIndicator() {
  const { jobs, active, failed, progress, cancel, clearFinished } = useUploads();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onDown(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (jobs.length === 0) return null;

  const percent = progress === null ? 100 : Math.round(progress * 100);
  const label =
    active > 0
      ? `Uploading ${active} ${active === 1 ? 'file' : 'files'}, ${percent}%`
      : failed > 0
        ? `${failed} ${failed === 1 ? 'upload' : 'uploads'} failed`
        : 'Uploads finished';

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className="clay-button upload-chip"
        aria-expanded={open}
        aria-label={label}
        title={label}
        data-failed={active === 0 && failed > 0 ? '' : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <Ring percent={percent} busy={active > 0} failed={active === 0 && failed > 0} />
        <span className="upload-chip__text">
          {active > 0 ? `${percent}%` : failed > 0 ? `${failed} failed` : 'Done'}
        </span>
      </button>

      {open && (
        <div className="clay upload-pop" role="dialog" aria-label="Uploads">
          <header>
            <strong>{label}</strong>
            <span style={{ flex: 1 }} />
            {active > 0 ? (
              <button type="button" className="clay-button" onClick={cancel}>
                Cancel
              </button>
            ) : (
              <button type="button" className="clay-button" onClick={clearFinished}>
                Clear
              </button>
            )}
          </header>

          <ul>
            {/* Newest first: the one someone opened this to check on. */}
            {[...jobs].reverse().slice(0, 8).map((job) => (
              <li key={job.id}>
                <Row job={job} />
              </li>
            ))}
          </ul>

          <footer>
            <Link to="/uploads" onClick={() => setOpen(false)}>
              See all uploads
            </Link>
          </footer>
        </div>
      )}
    </div>
  );
}

export function Row({ job }: { job: UploadJob }) {
  const percent = job.sizeBytes > 0 ? Math.round((job.uploadedBytes / job.sizeBytes) * 100) : 0;

  return (
    <div className="upload-row">
      <div className="upload-row__top">
        <span className="upload-row__name" title={job.relativePath}>
          {job.relativePath}
        </span>
        <span className="upload-row__size">{formatBytes(job.sizeBytes)}</span>
      </div>

      {job.state === 'uploading' && (
        <div className="upload-row__track">
          <div style={{ width: `${percent}%` }} />
        </div>
      )}

      <span className="upload-row__state" data-state={job.state}>
        {job.state === 'error'
          ? (job.error ?? 'Failed')
          : job.state === 'cancelled'
            ? 'Cancelled'
            : job.state === 'queued'
              ? 'Waiting'
              : job.state === 'done'
                ? 'Uploaded'
                : `${percent}% · ${formatBytes(job.uploadedBytes)} of ${formatBytes(job.sizeBytes)}`}
      </span>

      {/*
        Where it went, always - not only once it has finished. With several
        accounts connected, and five catalogue entries sharing the s3 adapter,
        the account alone does not say which service or which bucket.
      */}
      <span className="upload-row__target">
        <span className="upload-row__provider">{job.provider}</span>
        <span aria-hidden="true">·</span>
        <span>{job.destination}</span>
        <span aria-hidden="true">·</span>
        <span className="upload-row__path">{job.targetPath}</span>
      </span>
    </div>
  );
}

/**
 * A progress ring rather than a bar: it sits in a header where there is height
 * but no width to spare, and it reads at a glance without a label.
 */
function Ring({ percent, busy, failed }: { percent: number; busy: boolean; failed: boolean }) {
  const radius = 8;
  const circumference = 2 * Math.PI * radius;

  return (
    <svg viewBox="0 0 20 20" width={18} height={18} aria-hidden="true" style={{ display: 'block' }}>
      <circle cx="10" cy="10" r={radius} fill="none" stroke="currentColor" strokeWidth="2.4" opacity="0.2" />
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        stroke={failed ? 'var(--danger)' : 'currentColor'}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - percent / 100)}
        // Drawn from the top rather than from three o'clock, which is where an
        // undialled ring otherwise appears to start.
        transform="rotate(-90 10 10)"
        style={{ transition: 'stroke-dashoffset var(--dur-fast) linear' }}
      />
      {!busy && !failed && <path d="M6.6 10.2 9 12.6l4.4-4.6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}
