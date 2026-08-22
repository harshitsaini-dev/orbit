import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Skeleton } from './Skeleton.js';

/**
 * What one published link has been doing.
 *
 * Two things this deliberately does not show, and says so rather than leaving
 * a reader to assume otherwise.
 *
 * It does not count unique visitors. Doing that means a cookie or a
 * fingerprint on somebody who followed a link a friend sent them and agreed to
 * nothing — a much larger thing to do to a stranger than the question is
 * worth. So it says "opens", which is what it actually knows.
 *
 * And it separates the opens that were not people. A link pasted into WhatsApp
 * or Slack is fetched immediately by their preview crawlers, and counting
 * those as readers tells somebody their link is popular when nobody has looked
 * at it.
 */

interface Stats {
  daily: Array<{ date: string; views: number; downloads: number }>;
  views: number;
  downloads: number;
  bots: number;
  byDevice: { desktop: number; mobile: number; bot: number };
  lastViewedAt: string | null;
}

function when(iso: string | null): string {
  if (!iso) return 'Never opened';

  const minutes = (Date.now() - new Date(iso).getTime()) / 60_000;
  if (minutes < 60) return 'Opened in the last hour';
  if (minutes < 1440) return `Opened ${Math.round(minutes / 60)}h ago`;
  return `Opened ${Math.round(minutes / 1440)}d ago`;
}

export function ShareStats({ shortId }: { shortId: string }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    api<{ stats: Stats }>(`/api/shares/${shortId}/stats`, { signal: controller.signal })
      .then(({ stats: rows }) => setStats(rows))
      // An abort is this component being closed or re-mounted, not a failure -
      // and under StrictMode the first mount always aborts, so treating it as
      // one shows an error every single time in development.
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setError(true);
      });

    return () => controller.abort();
  }, [shortId]);

  if (error) {
    return <p className="share-stats__empty">Could not read this link&apos;s activity.</p>;
  }

  if (!stats) {
    return (
      <div className="share-stats">
        <Skeleton height={64} />
      </div>
    );
  }

  // The tallest day sets the scale; an all-zero month must not divide by zero.
  const peak = Math.max(1, ...stats.daily.map((day) => day.views + day.downloads));

  return (
    <div className="share-stats">
      <div className="share-stats__figures">
        <span>
          <strong>{stats.views}</strong> opens
        </span>
        <span>
          <strong>{stats.downloads}</strong> downloads
        </span>
        <span>
          <strong>{stats.byDevice.mobile}</strong> on a phone
        </span>
        {stats.bots > 0 && (
          <span className="share-stats__bots">
            <strong>{stats.bots}</strong> by link previews, not people
          </span>
        )}
        <span className="share-stats__when">{when(stats.lastViewedAt)}</span>
      </div>

      <div className="share-stats__chart" aria-hidden="true">
        {stats.daily.map((day) => {
          const total = day.views + day.downloads;

          return (
            <span
              key={day.date}
              className="share-stats__bar"
              title={`${day.date}: ${day.views} opens, ${day.downloads} downloads`}
              data-empty={total === 0 ? '' : undefined}
            >
              <span style={{ height: `${(total / peak) * 100}%` }} />
            </span>
          );
        })}
      </div>

      <p className="share-stats__note">
        Last 30 days. Orbit counts opens, not visitors — telling one person refreshing from ten
        people looking would mean putting a cookie on somebody who only followed a link.
      </p>
    </div>
  );
}
