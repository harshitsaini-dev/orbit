import { Link } from 'react-router-dom';
import { Row } from '../components/UploadIndicator.js';
import { useUploads } from '../lib/uploads.js';

/**
 * Everything uploaded this session, the way a browser keeps a downloads page.
 *
 * The header chip is for glancing at; this is for reading. It is where a failed
 * upload's reason can be seen in full rather than truncated into a row, which
 * matters because those reasons are usually actionable - a folder that is no
 * longer shared, an account out of space.
 *
 * It does not survive a reload: the queue holds handles to files on disk, and
 * a handle cannot be restored from storage. A history that claimed to be
 * complete and was not would be worse than one that says what it covers.
 */
export function Uploads() {
  const { jobs, active, failed, cancel, clearFinished } = useUploads();

  const finished = jobs.filter((job) => job.state !== 'uploading' && job.state !== 'queued');

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'grid', gap: 4 }}>
            <h1 style={{ fontSize: '1.4rem', margin: 0 }}>Uploads</h1>
            <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: 14 }}>
              {jobs.length === 0
                ? 'Nothing has been uploaded this session.'
                : `${active} in progress, ${finished.length - failed} finished, ${failed} failed.`}
            </p>
          </div>

          <span style={{ flex: 1 }} />

          {active > 0 && (
            <button type="button" className="clay-button" onClick={cancel}>
              Cancel remaining
            </button>
          )}
          {finished.length > 0 && (
            <button type="button" className="clay-button" onClick={clearFinished}>
              Clear finished
            </button>
          )}
        </div>
      </section>

      {jobs.length === 0 ? (
        <section className="clay" style={{ padding: 'clamp(1.5rem, 4vw, 2.5rem)', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>
            Uploads started from <Link to="/my-drive">My Drive</Link> appear here while they run, and
            stay listed afterwards so a failure can be read in full.
          </p>
        </section>
      ) : (
        <section className="clay" style={{ padding: '0.75rem' }}>
          <ul className="upload-list">
            {[...jobs].reverse().map((job) => (
              <li key={job.id}>
                <Row job={job} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
