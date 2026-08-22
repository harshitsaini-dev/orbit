import { useEffect, useState } from 'react';
import {
  CATEGORY_COLOURS,
  CATEGORY_LABELS,
  catalogueEntry,
  type CategoryTotal,
} from '@orbit/shared-types';
import { api } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';
import { ProviderIcon } from './ProviderIcon.js';

/**
 * What is stored, split by the kind of storage it is in, and what it all is.
 *
 * A Google Drive and an S3 bucket are not the same sort of thing, and one
 * figure covering both says less than either alone. A Drive has an allowance
 * that can run out, so "12 GB of 15 GB" is the number that matters. A bucket
 * has a bill rather than a limit, so a percentage of nothing is a meaningless
 * bar and the useful number is simply how much is in there.
 *
 * The split is on the provider's own `reportsQuota` capability rather than on
 * its name, so a new adapter lands on the right side of the line without
 * anything here being changed.
 */

type StorageKind = 'allowance' | 'metered';

interface SummaryAccount {
  accountId: string;
  nickname: string;
  provider: string;
  catalogueKey: string | null;
  usedBytes: number;
  quotaBytes: number;
  indexedBytes: number;
  fileCount: number;
}

interface StorageGroup {
  kind: StorageKind;
  accounts: SummaryAccount[];
  usedBytes: number;
  quotaBytes: number;
  totals: CategoryTotal[];
  fileCount: number;
}

interface SharedDrive {
  accountId: string;
  accountNickname: string;
  driveId: string;
  name: string;
  path: string;
  measured: Measurement | null;
}

interface Measurement {
  sizeBytes: number;
  fileCount: number;
  totals: CategoryTotal[];
  /** True only when the listing could not be finished, not when it was capped. */
  partial: boolean;
  measuredAt: string;
}

function measuredAgo(iso: string): string {
  const hours = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (hours < 1) return 'measured just now';
  if (hours < 24) return `measured ${Math.round(hours)}h ago`;
  return `measured ${new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

/**
 * One shared drive, with what was last worked out about it.
 *
 * Google reports no quota for a shared drive, so a size means listing every
 * file in it - over a minute on a real one. That happens on the sync pass with
 * nobody waiting, which is what lets it run to the end rather than stopping at
 * a cap; the page shows the last figure and when it was taken.
 *
 * The button is for impatience, not for the ordinary case: somebody who has
 * just changed something and does not want to wait for the next pass.
 */
function SharedDriveRow({ drive }: { drive: SharedDrive }) {
  const [measurement, setMeasurement] = useState<Measurement | null>(drive.measured);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function measure(): Promise<void> {
    setBusy(true);
    setFailed(false);

    try {
      const { drive: result } = await api<{ drive: Measurement }>(
        `/api/accounts/${drive.accountId}/shared-drives/${encodeURIComponent(drive.driveId)}/measure`,
        { method: 'POST', body: { name: drive.name } },
      );
      setMeasurement(result);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="shared-drive">
      <div className="shared-drive__head">
        <ProviderIcon provider="google_drive" size={17} />

        <span className="storage-group__name">
          <strong>{drive.name}</strong>
          <span>via {drive.accountNickname}</span>
        </span>

        <span className="storage-group__figure">
          {measurement
            ? `${measurement.partial ? 'at least ' : ''}${formatBytes(measurement.sizeBytes)} · ${measurement.fileCount.toLocaleString()} files`
            : busy
              ? 'Measuring…'
              : 'Not measured yet'}
        </span>

        <span className="shared-drive__actions">
          <button
            type="button"
            className="clay-button"
            // Said before it is pressed: on a drive of any size this is minutes
            // of listing, not an instant answer.
            title="Lists every file in the drive. Happens on its own every few hours; this does it now."
            disabled={busy}
            onClick={() => void measure()}
          >
            {busy ? 'Measuring…' : measurement ? 'Re-measure' : 'Measure now'}
          </button>

          <a
            className="clay-button"
            href={`/my-drive?account=${encodeURIComponent(drive.accountId)}&path=${encodeURIComponent(drive.path)}`}
          >
            Open
          </a>
        </span>
      </div>

      {failed && (
        <p className="share-hint" style={{ margin: 0 }}>
          Could not measure that drive.
        </p>
      )}

      {measurement && (
        <>
          <CategoryBar totals={measurement.totals} />
          <CategoryLegend totals={measurement.totals} />
          <p className="share-hint" style={{ margin: 0 }}>
            {measuredAgo(measurement.measuredAt)}
            {measurement.partial &&
              ' — the listing could not be finished, so these are a floor rather than a total.'}
          </p>
        </>
      )}
    </li>
  );
}

interface Summary {
  groups: StorageGroup[];
  sharedDrives: SharedDrive[];
  overall: { usedBytes: number; quotaBytes: number; totals: CategoryTotal[]; fileCount: number };
  unindexed: number;
}

const COPY: Record<StorageKind, { title: string; blurb: string }> = {
  allowance: {
    title: 'Drives with an allowance',
    blurb: 'Google Drive, OneDrive, Dropbox — storage that can run out.',
  },
  metered: {
    title: 'Metered storage',
    blurb: 'S3, R2, Supabase — no limit to run into, so what matters is how much is in there.',
  },
};

/** A stacked bar of what the files are. Reads left to right, largest first. */
function CategoryBar({ totals }: { totals: CategoryTotal[] }) {
  const total = totals.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  if (total === 0) return null;

  return (
    <div className="cat-bar" role="img" aria-label="Breakdown by kind of file">
      {totals.map((entry) => (
        <span
          key={entry.category}
          style={{
            width: `${(entry.sizeBytes / total) * 100}%`,
            background: CATEGORY_COLOURS[entry.category],
          }}
          title={`${CATEGORY_LABELS[entry.category]} · ${formatBytes(entry.sizeBytes)}`}
        />
      ))}
    </div>
  );
}

function CategoryLegend({ totals }: { totals: CategoryTotal[] }) {
  if (totals.length === 0) {
    return (
      <p className="share-hint" style={{ margin: 0 }}>
        Nothing indexed yet. Sync an account to see what is in it.
      </p>
    );
  }

  return (
    <ul className="cat-legend">
      {totals.map((entry) => (
        <li key={entry.category}>
          <span style={{ background: CATEGORY_COLOURS[entry.category] }} />
          {/* Truncated rather than wrapped, so the numbers beside it stay in
              their columns; the full label is on the element either way. */}
          <strong title={CATEGORY_LABELS[entry.category]}>{CATEGORY_LABELS[entry.category]}</strong>
          <span>{formatBytes(entry.sizeBytes)}</span>
          <span>
            {entry.fileCount.toLocaleString()} {entry.fileCount === 1 ? 'file' : 'files'}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function StorageGroups() {
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<Summary>('/api/storage/summary', { signal: controller.signal })
      .then(setSummary)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  if (!summary || summary.groups.length === 0) return null;

  return (
    <>
      {/* The master figure first: "how much have I got" is the question people
          arrive with, and the split is what they ask next. */}
      <section className="clay storage-group" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
        <header>
          <h2>Everything, by kind of file</h2>
          <span>
            {formatBytes(summary.overall.usedBytes)} across{' '}
            {summary.overall.fileCount.toLocaleString()} indexed files
          </span>
        </header>

        <CategoryBar totals={summary.overall.totals} />
        <CategoryLegend totals={summary.overall.totals} />

        {summary.unindexed > 0 && (
          <p className="share-hint" style={{ margin: 0 }}>
            {summary.unindexed} {summary.unindexed === 1 ? 'account has' : 'accounts have'} nothing
            indexed yet, so their files are not counted in this breakdown — only in the totals each
            provider reports.
          </p>
        )}
      </section>

      {/* Listed, not counted. Leaving them out of the storage views entirely
          was the other way to be wrong: they are nobody's allowance, but a
          person looking at their storage still wants to know they exist. */}
      {summary.sharedDrives.length > 0 && (
        <section className="clay storage-group" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
          <header>
            <h2>Shared drives</h2>
            <span>
              {summary.sharedDrives.length}{' '}
              {summary.sharedDrives.length === 1 ? 'drive' : 'drives'} · not counted above
            </span>
          </header>

          <p className="share-hint" style={{ margin: 0 }}>
            These belong to an organisation, and none of it counts against your own allowance.
            Google pools their storage and reports no quota per drive, so a size has to be worked
            out by listing the whole drive. That happens on its own every few hours, in the
            background — a drive of any size takes minutes, which is not something to make you
            wait for.
          </p>

          <ul className="shared-drive-list">
            {summary.sharedDrives.map((drive) => (
              <SharedDriveRow key={`${drive.accountId}:${drive.driveId}`} drive={drive} />
            ))}
          </ul>
        </section>
      )}

      {summary.groups.map((group) => (
        <section
          key={group.kind}
          className="clay storage-group"
          style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}
        >
          <header>
            <h2>{COPY[group.kind].title}</h2>
            <span>
              {group.kind === 'allowance'
                ? `${formatBytes(group.usedBytes)} of ${formatBytes(group.quotaBytes)}`
                : `${formatBytes(group.usedBytes)} stored`}
            </span>
          </header>

          <p className="share-hint" style={{ margin: 0 }}>
            {COPY[group.kind].blurb}
          </p>

          <CategoryBar totals={group.totals} />

          <ul className="storage-group__accounts">
            {group.accounts.map((account) => {
              const pct =
                account.quotaBytes > 0 ? (account.usedBytes / account.quotaBytes) * 100 : 0;

              return (
                <li key={account.accountId}>
                  <ProviderIcon provider={account.catalogueKey ?? account.provider} size={17} />
                  <span className="storage-group__name">
                    <strong>{account.nickname}</strong>
                    <span>
                      {catalogueEntry(account.catalogueKey ?? '')?.label ??
                        account.provider.replace(/_/g, ' ')}
                    </span>
                  </span>

                  {account.quotaBytes > 0 ? (
                    <span className="storage-group__meter">
                      <span style={{ width: `${Math.min(pct, 100)}%` }} />
                    </span>
                  ) : (
                    <span />
                  )}

                  <span className="storage-group__figure">
                    {account.quotaBytes > 0
                      ? `${formatBytes(account.usedBytes)} of ${formatBytes(account.quotaBytes)}`
                      : `${formatBytes(account.usedBytes)} stored`}
                  </span>
                </li>
              );
            })}
          </ul>

          <CategoryLegend totals={group.totals} />
        </section>
      ))}
    </>
  );
}
