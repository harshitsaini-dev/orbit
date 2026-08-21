import { useEffect, useState } from 'react';
import type { StorageBreakdown as Breakdown } from '@orbit/shared-types';
import { CATEGORY_COLOURS, CATEGORY_LABELS } from '@orbit/shared-types';
import { api, ApiError } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';

/**
 * The Google One style "what is using the space" panel. The scan behind it is
 * bounded, so a partial result says so rather than presenting an undercount as
 * the total.
 */
export function StorageBreakdownPanel({ accountId }: { accountId: string }) {
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);

  async function load(force = false) {
    setBusy(true);
    setError(null);
    try {
      const { breakdown: result } = await api<{ breakdown: Breakdown }>(
        `/api/accounts/${accountId}/breakdown${force ? '?refresh=1' : ''}`,
      );
      setBreakdown(result);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.code === 'breakdown_unsupported'
            ? 'This provider cannot list its files in one pass, so a breakdown is not available.'
            : err.message
          : 'Could not scan this account',
      );
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    // Reset when the panel is pointed at a different account.
    setBreakdown(null);
    setError(null);
    setStarted(false);
  }, [accountId]);

  if (!started) {
    return (
      <button
        type="button"
        className="clay-button"
        style={{ padding: '0.4rem 1rem', fontSize: 13, justifySelf: 'start' }}
        onClick={() => {
          setStarted(true);
          void load();
        }}
      >
        Show what is using the space
      </button>
    );
  }

  if (busy && !breakdown) {
    return <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>Scanning…</p>;
  }

  if (error) {
    return (
      <p role="alert" style={{ color: 'var(--danger)', fontSize: 13, margin: 0 }}>
        {error}
      </p>
    );
  }

  if (!breakdown) return null;

  const total = breakdown.sizeBytes || 1;

  return (
    <div style={{ display: 'grid', gap: 10 }} data-testid="breakdown">
      <div
        style={{ display: 'flex', height: 12, borderRadius: 'var(--radius-pill)', overflow: 'hidden', gap: 2 }}
        role="img"
        aria-label={`Storage by category: ${breakdown.totals
          .map((t) => `${CATEGORY_LABELS[t.category]} ${formatBytes(t.sizeBytes)}`)
          .join(', ')}`}
      >
        {breakdown.totals.map((entry) => (
          <div
            key={entry.category}
            title={`${CATEGORY_LABELS[entry.category]} — ${formatBytes(entry.sizeBytes)}`}
            style={{
              width: `${Math.max((entry.sizeBytes / total) * 100, 0.6)}%`,
              background: CATEGORY_COLOURS[entry.category],
            }}
          />
        ))}
      </div>

      <ul
        style={{
          listStyle: 'none',
          padding: 0,
          margin: 0,
          display: 'grid',
          gap: 6,
          gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
        }}
      >
        {breakdown.totals.map((entry) => (
          <li key={entry.category} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <span
              aria-hidden="true"
              style={{
                width: 10,
                height: 10,
                borderRadius: 3,
                background: CATEGORY_COLOURS[entry.category],
                flexShrink: 0,
              }}
            />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {CATEGORY_LABELS[entry.category]}
            </span>
            <span style={{ color: 'var(--text-muted)' }}>{formatBytes(entry.sizeBytes)}</span>
          </li>
        ))}
      </ul>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: 'var(--text-muted)' }}>
        <span>
          {breakdown.fileCount.toLocaleString()} files · {formatBytes(breakdown.sizeBytes)}
        </span>
        {breakdown.partial && (
          <span style={{ color: 'var(--warning)' }}>
            Partial — the scan stopped at its page limit, so this is a lower bound.
          </span>
        )}
        <button
          type="button"
          className="clay-button"
          style={{ padding: '0.25rem 0.8rem', fontSize: 12 }}
          disabled={busy}
          onClick={() => void load(true)}
        >
          {busy ? 'Scanning…' : 'Rescan'}
        </button>
      </div>
    </div>
  );
}
