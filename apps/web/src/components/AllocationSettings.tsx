import { useState } from 'react';
import { catalogueEntry, type AllocationStrategy, type PublicAccount } from '@orbit/shared-types';
import { api } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';
import { ProviderIcon } from './ProviderIcon.js';

/**
 * Where an upload goes when the user has not picked an account.
 *
 * Each option says what it does in a sentence rather than by its name, because
 * "weighted round robin" tells nobody anything. The one that is chosen is the
 * one that will be used for every upload started from a view that is not a
 * single account, so it is worth being clear about.
 */

const STRATEGIES: Array<{ value: AllocationStrategy; label: string; blurb: string }> = [
  {
    value: 'round_robin',
    label: 'Take turns',
    blurb: 'Each upload goes to the next account in order. Spreads files evenly.',
  },
  {
    value: 'most_free',
    label: 'Wherever there is most room',
    blurb: 'Fills the emptiest account first, so no single one runs out early.',
  },
  {
    value: 'least_used',
    label: 'Wherever Orbit has put least',
    blurb:
      'Counts only what Orbit uploaded, so accounts that were already full do not stay untouched.',
  },
  {
    value: 'weighted_round_robin',
    label: 'Take turns, but favour some',
    blurb: 'Like taking turns, with a weight per account. A weight of 0 parks one without disconnecting it.',
  },
  {
    value: 'manual',
    label: 'Follow my order',
    blurb: 'Always the first account in your list that still has room.',
  },
];

export function AllocationSettings({
  strategy,
  accounts,
  onChanged,
}: {
  strategy: AllocationStrategy;
  accounts: PublicAccount[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState(strategy);

  async function choose(value: AllocationStrategy): Promise<void> {
    setCurrent(value);
    setBusy(true);
    try {
      await api('/api/allocation', { method: 'PUT', body: { strategy: value } });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function setWeight(accountId: string, weight: number): Promise<void> {
    await api(`/api/accounts/${accountId}/weight`, { method: 'PUT', body: { weight } });
    onChanged();
  }

  return (
    <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
      <h2 style={{ fontSize: '1.15rem', margin: 0 }}>Where uploads go</h2>
      <p style={{ color: 'var(--text-muted)', margin: '0.4rem 0 0', fontSize: 14 }}>
        When you upload from a view that is not one account — a collection, or a drop onto the
        workspace — Orbit picks for you. This is how.
      </p>

      <ul className="allocation">
        {STRATEGIES.map((option) => (
          <li key={option.value}>
            <label>
              <input
                type="radio"
                name="allocation"
                value={option.value}
                checked={current === option.value}
                disabled={busy}
                onChange={() => void choose(option.value)}
              />
              <span>
                <strong>{option.label}</strong>
                <span>{option.blurb}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>

      {/* Weights only mean something for the one strategy that reads them. */}
      {current === 'weighted_round_robin' && accounts.length > 0 && (
        <div className="allocation__weights">
          <h3>Weights</h3>
          <ul>
            {accounts.map((account) => (
              <li key={account.id}>
                <ProviderIcon provider={account.catalogueKey ?? account.provider} size={16} />
                <span className="allocation__account">
                  <strong>{account.nickname}</strong>
                  <span>{catalogueEntry(account.catalogueKey ?? '')?.label ?? account.provider}</span>
                </span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={account.weight}
                  aria-label={`Weight for ${account.nickname}`}
                  onBlur={(event) => void setWeight(account.id, Number(event.target.value))}
                />
              </li>
            ))}
          </ul>
          <p>A weight of 0 means never, without disconnecting the account.</p>
        </div>
      )}

      {current === 'manual' && accounts.length > 0 && (
        <div className="allocation__weights">
          <h3>Your order</h3>
          <ol>
            {accounts.map((account) => (
              <li key={account.id}>
                <ProviderIcon provider={account.catalogueKey ?? account.provider} size={16} />
                <span className="allocation__account">
                  <strong>{account.nickname}</strong>
                  <span>
                    {account.quotaBytes > 0
                      ? `${formatBytes(account.quotaBytes - account.usedBytes)} free`
                      : 'no limit reported'}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          <p>Uploads go to the first of these with room for the file.</p>
        </div>
      )}
    </section>
  );
}
