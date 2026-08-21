import { useEffect, useState } from 'react';
import type { PublicAccount, StorageBreakdown } from '@orbit/shared-types';
import { CATEGORY_COLOURS, CATEGORY_LABELS } from '@orbit/shared-types';
import { api, ApiError } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';

interface Segment {
  key: string;
  label: string;
  bytes: number;
  colour: string;
}

const UNACCOUNTED_COLOUR = 'var(--text-muted)';

/**
 * One bar for the whole account: the track is the full allowance, the filled
 * part is what is used, and the colours inside it are what is using it.
 *
 * The two-level structure matters. A 12 GB usage against a 5 TB allowance is
 * 0.24% of the track, so giving every category a minimum width on the *track*
 * would render eight slivers adding up to several percent and overstate usage
 * by more than an order of magnitude. Categories are therefore proportioned
 * against the used block, not against the allowance, and the legend carries the
 * exact figures — which is where the detail is legible anyway.
 *
 * The breakdown loads on its own; the bar is drawn immediately from the cached
 * quota figures and refines in place, so nothing jumps.
 */
export function StorageBar({ account }: { account: PublicAccount }) {
  const [breakdown, setBreakdown] = useState<StorageBreakdown | null>(null);
  const [scanning, setScanning] = useState(true);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setBreakdown(null);
    setUnsupported(false);
    setError(null);
    setScanning(true);

    api<{ breakdown: StorageBreakdown }>(`/api/accounts/${account.id}/breakdown`, {
      signal: controller.signal,
    })
      .then(({ breakdown: result }) => setBreakdown(result))
      .catch((err: unknown) => {
        if ((err as Error).name === 'AbortError') return;
        if (err instanceof ApiError && err.code === 'breakdown_unsupported') {
          setUnsupported(true);
          return;
        }
        // A failed scan still leaves a usable bar, so this stays quiet.
        setError(err instanceof ApiError ? err.message : 'Could not scan this account');
      })
      .finally(() => {
        if (!controller.signal.aborted) setScanning(false);
      });

    return () => controller.abort();
  }, [account.id]);

  async function rescan() {
    setScanning(true);
    setError(null);
    try {
      const { breakdown: result } = await api<{ breakdown: StorageBreakdown }>(
        `/api/accounts/${account.id}/breakdown?refresh=1`,
      );
      setBreakdown(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not rescan');
    } finally {
      setScanning(false);
    }
  }

  const hasLimit = account.quotaBytes > 0;
  const used = Math.max(0, account.usedBytes);
  const free = hasLimit ? Math.max(0, account.quotaBytes - used) : 0;

  const segments: Segment[] = [];

  if (breakdown && breakdown.totals.length > 0) {
    for (const total of breakdown.totals) {
      segments.push({
        key: total.category,
        label: CATEGORY_LABELS[total.category],
        bytes: total.sizeBytes,
        colour: CATEGORY_COLOURS[total.category],
      });
    }

    // The provider's usage figure covers what a file scan cannot see - the
    // trash, and on Google, Gmail and Photos. Showing the difference is more
    // honest than letting the categories quietly fail to add up.
    const unaccounted = used - breakdown.sizeBytes;
    if (unaccounted > used * 0.01) {
      segments.push({
        key: 'unaccounted',
        label: 'Trash and other services',
        bytes: unaccounted,
        colour: UNACCOUNTED_COLOUR,
      });
    }
  } else {
    segments.push({ key: 'used', label: 'Used', bytes: used, colour: 'var(--accent)' });
  }

  const segmentTotal = Math.max(1, segments.reduce((sum, segment) => sum + segment.bytes, 0));
  const usedPercent = hasLimit ? (used / account.quotaBytes) * 100 : 100;
  const nearlyFull = hasLimit && usedPercent > 90;

  return (
    <div style={{ display: 'grid', gap: 10 }} data-testid="storage-bar">
      <div
        className="clay-sunken"
        style={{ height: 12, borderRadius: 'var(--radius-pill)', overflow: 'hidden' }}
        role="img"
        aria-label={[
          ...segments.map((segment) => `${segment.label} ${formatBytes(segment.bytes)}`),
          hasLimit ? `Free ${formatBytes(free)}` : null,
        ]
          .filter(Boolean)
          .join(', ')}
      >
        <div
          style={{
            display: 'flex',
            height: '100%',
            width: `${usedPercent}%`,
            // A sub-pixel sliver cannot be drawn at all; this makes a small
            // usage visible without changing the proportion it represents.
            minWidth: used > 0 ? 3 : 0,
            transition: 'width var(--dur-base) var(--ease-clay)',
          }}
        >
          {segments
            .filter((segment) => segment.bytes > 0)
            .map((segment) => (
              <div
                key={segment.key}
                title={`${segment.label} — ${formatBytes(segment.bytes)}`}
                style={{
                  width: `${(segment.bytes / segmentTotal) * 100}%`,
                  background:
                    segment.key === 'used' && nearlyFull ? 'var(--danger)' : segment.colour,
                }}
              />
            ))}
        </div>
      </div>

      <ul
        style={{
          listStyle: 'none',
          padding: 0,
          margin: 0,
          display: 'grid',
          gap: 6,
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
        }}
      >
        {segments
          .filter((segment) => segment.bytes > 0)
          .map((segment) => (
            <LegendRow
              key={segment.key}
              colour={segment.colour}
              label={segment.label}
              bytes={segment.bytes}
              share={used > 0 ? (segment.bytes / used) * 100 : 0}
            />
          ))}

        {hasLimit && (
          <LegendRow
            hollow
            colour="transparent"
            label="Free"
            bytes={free}
            share={(free / account.quotaBytes) * 100}
            shareOf="of allowance"
          />
        )}
      </ul>

      <div
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          flexWrap: 'wrap',
          fontSize: 12,
          color: 'var(--text-muted)',
        }}
      >
        <span>
          {hasLimit
            ? `${formatBytes(used)} of ${formatBytes(account.quotaBytes)} used`
            : `${formatBytes(used)} stored · no reported limit`}
        </span>

        {breakdown && <span>{breakdown.fileCount.toLocaleString()} files scanned</span>}
        {scanning && <span>Scanning…</span>}

        {breakdown?.partial && (
          <span style={{ color: 'var(--warning)' }}>
            Partial — the scan stopped at its page limit, so the categories are a lower bound.
          </span>
        )}
        {unsupported && <span>This provider cannot list its files in one pass.</span>}
        {error && (
          <span role="alert" style={{ color: 'var(--danger)' }}>
            {error}
          </span>
        )}

        {!unsupported && (
          <button
            type="button"
            className="clay-button"
            style={{ padding: '0.25rem 0.8rem', fontSize: 12 }}
            disabled={scanning}
            onClick={() => void rescan()}
          >
            {scanning ? 'Scanning…' : 'Rescan'}
          </button>
        )}
      </div>
    </div>
  );
}

function LegendRow({
  colour,
  label,
  bytes,
  share,
  hollow,
  shareOf = 'of used',
}: {
  colour: string;
  label: string;
  bytes: number;
  share: number;
  hollow?: boolean;
  shareOf?: string;
}) {
  return (
    <li style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, minWidth: 0 }}>
      <span
        aria-hidden="true"
        style={{
          width: 10,
          height: 10,
          borderRadius: 3,
          flexShrink: 0,
          background: hollow ? 'transparent' : colour,
          border: hollow ? '1.5px solid var(--border)' : undefined,
        }}
      />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: hollow ? 'var(--text-muted)' : undefined,
        }}
      >
        {label}
      </span>
      <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title={`${share.toFixed(1)}% ${shareOf}`}>
        {formatBytes(bytes)}
      </span>
    </li>
  );
}
