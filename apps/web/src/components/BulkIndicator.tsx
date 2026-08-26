import { bulkVerb, useBulk } from '../lib/bulk.js';

/**
 * What a bulk delete, restore or purge is doing, from anywhere in the app.
 *
 * The counter used to live on the page that started the job, so walking off to
 * Quota mid-delete left nothing on screen saying anything was still happening
 * — and the job appeared to have stopped. It had not, but there is no
 * difference between work you cannot see and work that is not running.
 *
 * Sits in the header beside the upload chip, for the same reason and in the
 * same shape: present only while there is something to report.
 */
export function BulkIndicator() {
  const { jobs, active, clearFinished } = useBulk();
  const latest = active ?? jobs[jobs.length - 1];

  if (!latest) return null;

  const percent = latest.total === 0 ? 100 : Math.round((latest.done / latest.total) * 100);

  if (latest.state === 'running') {
    return (
      <span className="bulk-chip" role="status" aria-live="polite">
        <span
          className="bulk-chip__fill"
          style={{ width: `${percent}%` }}
          role="progressbar"
          aria-valuenow={latest.done}
          aria-valuemin={0}
          aria-valuemax={latest.total}
        />
        <span className="bulk-chip__text">
          {bulkVerb(latest.kind, false)} {latest.done.toLocaleString()} of{' '}
          {latest.total.toLocaleString()}
        </span>
      </span>
    );
  }

  /*
   * The finished state stays until it is dismissed. A job that ran while the
   * reader was on another page would otherwise complete with nothing ever
   * having said so - and a delete of fifty thousand files is exactly the thing
   * somebody wants confirmed rather than inferred.
   */
  const message =
    latest.state === 'error'
      ? `${latest.error ?? 'That did not work'}${latest.done > 0 ? ` — ${latest.done.toLocaleString()} of ${latest.total.toLocaleString()} were done first.` : ''}`
      : latest.failed > 0
        ? `${bulkVerb(latest.kind, true)} ${(latest.total - latest.failed).toLocaleString()} of ${latest.total.toLocaleString()}; ${latest.failed.toLocaleString()} could not be${latest.reason ? `: ${latest.reason}` : '.'}`
        : `${bulkVerb(latest.kind, true)} ${latest.total.toLocaleString()} ${latest.total === 1 ? 'file' : 'files'}.`;

  return (
    <button
      type="button"
      className="bulk-chip bulk-chip--done"
      data-failed={latest.state === 'error' || latest.failed > 0 ? '' : undefined}
      title={message}
      aria-label={`${message} Dismiss.`}
      onClick={clearFinished}
    >
      <span className="bulk-chip__text">{message}</span>
    </button>
  );
}
