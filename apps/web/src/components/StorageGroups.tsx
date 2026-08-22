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

interface Summary {
  groups: StorageGroup[];
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
          <strong>{CATEGORY_LABELS[entry.category]}</strong>
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
