import { catalogueEntry, type PublicAccount } from '@orbit/shared-types';
import { formatBytes } from '../lib/format.js';
import { ProviderIcon } from './ProviderIcon.js';

/**
 * Every connected account's usage in one ring.
 *
 * The point is the number nobody can work out by hand: with a dozen accounts,
 * how much is used and how much is left in total. Each account gets its own
 * colour and its own arc, so a full one is visible before a total is read.
 *
 * Accounts that report no allowance - a bucket has none - are counted in the
 * used figure and excluded from the total, and the page says so. Silently
 * folding them into a percentage would give a number that is wrong in a
 * direction nobody can see.
 */

/** Enough for more accounts than anyone connects; it wraps rather than runs out. */
const COLOURS = [
  '#6c8cff',
  '#2fa87a',
  '#d95c8a',
  '#e08a2e',
  '#8b6cf5',
  '#37a6c4',
  '#c4569b',
  '#6f7ba8',
];

const RADIUS = 54;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function StorageDonut({ accounts }: { accounts: PublicAccount[] }) {
  const measured = accounts.filter((account) => account.quotaBytes > 0);
  const unmeasured = accounts.filter((account) => account.quotaBytes <= 0);

  const totalQuota = measured.reduce((sum, account) => sum + account.quotaBytes, 0);
  const measuredUsed = measured.reduce((sum, account) => sum + account.usedBytes, 0);
  const allUsed = accounts.reduce((sum, account) => sum + account.usedBytes, 0);

  if (accounts.length === 0) return null;

  // Each arc is that account's share of the whole allowance, so the ring reads
  // as one drive assembled from several.
  let offset = 0;
  const arcs = measured.map((account, index) => {
    const fraction = totalQuota > 0 ? account.usedBytes / totalQuota : 0;
    const arc = {
      account,
      colour: COLOURS[index % COLOURS.length]!,
      // A used-but-tiny account still gets a visible sliver, or a drive with
      // twelve gigabytes on it looks empty.
      length: fraction > 0 ? Math.max(fraction * CIRCUMFERENCE, 3) : 0,
      offset,
    };
    offset += arc.length;
    return arc;
  });

  const exact = totalQuota > 0 ? (measuredUsed / totalQuota) * 100 : 0;
  // 12GB of 5TB rounds to 0%, which reads as "nothing stored" on an account
  // holding twelve gigabytes. Anything above nothing is at least a fraction.
  const percent =
    exact > 0 && exact < 1 ? '<1%' : totalQuota > 0 ? `${Math.round(exact)}%` : '';

  return (
    <div className="donut">
      <div className="donut__chart">
        <svg viewBox="0 0 140 140" width={168} height={168} role="img" aria-label={`${formatBytes(measuredUsed)} used of ${formatBytes(totalQuota)}`}>
          <circle
            cx="70"
            cy="70"
            r={RADIUS}
            fill="none"
            stroke="var(--accent-soft)"
            strokeWidth="16"
          />

          {arcs.map((arc) => (
            <circle
              key={arc.account.id}
              cx="70"
              cy="70"
              r={RADIUS}
              fill="none"
              stroke={arc.colour}
              strokeWidth="16"
              strokeDasharray={`${arc.length} ${CIRCUMFERENCE}`}
              strokeDashoffset={-arc.offset}
              // From twelve o'clock, which is where a ring appears to begin.
              transform="rotate(-90 70 70)"
            />
          ))}
        </svg>

        <div className="donut__centre">
          <strong>{totalQuota > 0 ? percent : formatBytes(allUsed)}</strong>
          <span>{totalQuota > 0 ? `of ${formatBytes(totalQuota)}` : 'used'}</span>
        </div>
      </div>

      <ul className="donut__legend">
        {arcs.map((arc) => (
          <li key={arc.account.id}>
            <span className="donut__swatch" style={{ background: arc.colour }} aria-hidden="true" />
            <ProviderIcon
              provider={arc.account.catalogueKey ?? arc.account.provider}
              size={16}
            />
            <span className="donut__name">
              <strong>{arc.account.nickname}</strong>
              <span>
                {catalogueEntry(arc.account.catalogueKey ?? '')?.label ?? arc.account.provider}
              </span>
            </span>
            <span className="donut__figure">
              {formatBytes(arc.account.usedBytes)}
              <span> of {formatBytes(arc.account.quotaBytes)}</span>
            </span>
          </li>
        ))}

        {unmeasured.map((account) => (
          <li key={account.id}>
            <span className="donut__swatch donut__swatch--none" aria-hidden="true" />
            <ProviderIcon provider={account.catalogueKey ?? account.provider} size={16} />
            <span className="donut__name">
              <strong>{account.nickname}</strong>
              <span>{catalogueEntry(account.catalogueKey ?? '')?.label ?? account.provider}</span>
            </span>
            <span className="donut__figure">
              {formatBytes(account.usedBytes)}
              {/* A bucket has no allowance to report, and inventing one would
                  draw a percentage against a number that does not exist. */}
              <span> · no limit reported</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
