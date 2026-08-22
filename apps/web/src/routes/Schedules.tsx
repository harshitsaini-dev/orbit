import { useCallback, useEffect, useState } from 'react';
import type { PublicAccount } from '@orbit/shared-types';
import { catalogueEntry } from '@orbit/shared-types';
import { ConfirmDialog } from '../components/NameDialog.js';
import { ProviderIcon } from '../components/ProviderIcon.js';
import { FileListSkeleton } from '../components/Skeleton.js';
import { StatusScreen, statusKindFor } from '../components/StatusScreen.js';
import { ApiError, api } from '../lib/api.js';

/**
 * Jobs that run again on their own.
 *
 * Described by a preset and a time, never a cron expression. Cron is a good
 * machine format and a poor thing to ask somebody to write, and "every Sunday
 * at 2am" is what people mean when they reach for it.
 *
 * The page is honest about the one thing that will surprise people: this Orbit
 * runs on an instance that sleeps, so a job whose moment passes while nothing is
 * awake runs late rather than at the time named.
 */

type Every = 'hourly' | 'daily' | 'weekly' | 'monthly';

interface Schedule {
  id: string;
  name: string;
  action: 'sync' | 'backup';
  config: Record<string, unknown>;
  every: Every;
  hour: number;
  minute: number;
  weekday: number | null;
  dayOfMonth: number | null;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastMessage: string | null;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** "Every Sunday at 02:00" — the sentence somebody would have said. */
function describe(schedule: Schedule): string {
  const at = `${pad(schedule.hour)}:${pad(schedule.minute)}`;

  switch (schedule.every) {
    case 'hourly':
      return `Every hour, at ${pad(schedule.minute)} past`;
    case 'daily':
      return `Every day at ${at}`;
    case 'weekly':
      return `Every ${DAYS[schedule.weekday ?? 0]} at ${at}`;
    case 'monthly':
      return `On the ${schedule.dayOfMonth ?? 1}${ordinal(schedule.dayOfMonth ?? 1)} of each month at ${at}`;
  }
}

function ordinal(day: number): string {
  if (day > 3 && day < 21) return 'th';
  return { 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] ?? 'th';
}

/** "in 4 hours", "3 days ago" — relative, because the exact stamp says less. */
function when(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);

  // Largest first, so "in 4 hours" wins over "in 240 minutes". The fallback is
  // the smallest unit, for anything under a minute - reaching for the first
  // entry of a largest-first list would report half a second as "today".
  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
  ];

  const [size, unit] = units.find(([threshold]) => abs >= threshold) ?? units[units.length - 1]!;
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  return formatter.format(Math.round(ms / size), unit);
}

export function Schedules() {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [accounts, setAccounts] = useState<PublicAccount[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The form.
  const [name, setName] = useState('');
  const [accountId, setAccountId] = useState('');
  const [every, setEvery] = useState<Every>('daily');
  const [hour, setHour] = useState(2);
  const [minute, setMinute] = useState(0);
  const [weekday, setWeekday] = useState(0);
  const [dayOfMonth, setDayOfMonth] = useState(1);

  const load = useCallback(async () => {
    try {
      const [{ schedules: rows }, { accounts: drives }] = await Promise.all([
        api<{ schedules: Schedule[] }>('/api/schedules'),
        api<{ accounts: PublicAccount[] }>('/api/accounts'),
      ]);
      setSchedules(rows);
      setAccounts(drives);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Could not load schedules'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setNotice(null);

    try {
      await api('/api/schedules', {
        method: 'POST',
        body: {
          name: name.trim(),
          action: 'sync',
          accountId: accountId || accounts[0]?.id,
          every,
          hour,
          minute,
          weekday: every === 'weekly' ? weekday : null,
          dayOfMonth: every === 'monthly' ? dayOfMonth : null,
        },
      });
      setName('');
      await load();
    } catch (err) {
      setNotice(
        err instanceof ApiError && err.status === 404
          ? 'That drive is not one you can sync'
          : 'Could not create that schedule',
      );
    }
  }

  async function toggle(schedule: Schedule): Promise<void> {
    // Optimistic: a switch that waits for a round trip before moving reads as
    // broken rather than as loading.
    setSchedules((rows) =>
      rows ? rows.map((r) => (r.id === schedule.id ? { ...r, enabled: !r.enabled } : r)) : rows,
    );

    try {
      await api(`/api/schedules/${schedule.id}`, {
        method: 'PATCH',
        body: { enabled: !schedule.enabled },
      });
    } catch {
      setNotice('Could not change that schedule');
      await load();
    }
  }

  async function runNow(schedule: Schedule): Promise<void> {
    setBusyId(schedule.id);
    setNotice(null);

    try {
      const { schedule: updated } = await api<{ schedule: Schedule }>(
        `/api/schedules/${schedule.id}/run`,
        { method: 'POST' },
      );
      setSchedules((rows) => (rows ? rows.map((r) => (r.id === updated.id ? updated : r)) : rows));
    } catch {
      setNotice('That run failed to start');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(schedule: Schedule): Promise<void> {
    await api(`/api/schedules/${schedule.id}`, { method: 'DELETE' });
    setDeleting(null);
    await load();
  }

  function driveName(schedule: Schedule): PublicAccount | undefined {
    const id = schedule.config['accountId'] ?? schedule.config['sourceAccountId'];
    return accounts.find((a) => a.id === id);
  }

  if (error && schedules === null) {
    return (
      <StatusScreen
        kind={error instanceof ApiError ? statusKindFor(error.status) : 'server-error'}
        onRetry={() => void load()}
      />
    );
  }

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
        <h1 style={{ fontSize: '1.4rem', margin: 0 }}>Schedules</h1>
        <p style={{ color: 'var(--text-muted)', margin: '0.4rem 0 0', lineHeight: 1.6 }}>
          Keep a drive’s index up to date without opening Orbit. Jobs run{' '}
          <strong>late rather than not at all</strong> — this instance sleeps when nobody is using
          it, so a two o’clock job whose moment passes while nothing is awake runs on the next
          wake-up instead.
        </p>
      </section>

      {notice && (
        <p role="alert" className="clay" style={{ padding: '0.8rem 1.1rem', color: 'var(--danger)', margin: 0 }}>
          {notice}
        </p>
      )}

      {schedules === null && (
        <section className="clay" style={{ padding: '0.75rem' }}>
          <FileListSkeleton rows={3} />
        </section>
      )}

      {schedules && schedules.length > 0 && (
        <ul className="schedule-list">
          {schedules.map((schedule) => {
            const drive = driveName(schedule);

            return (
              <li key={schedule.id} className="clay" data-off={schedule.enabled ? undefined : ''}>
                <div className="schedule__head">
                  <div className="schedule__title">
                    <strong>{schedule.name}</strong>
                    <span>{describe(schedule)}</span>
                  </div>

                  <label className="schedule__switch">
                    <input
                      type="checkbox"
                      checked={schedule.enabled}
                      onChange={() => void toggle(schedule)}
                    />
                    <span>{schedule.enabled ? 'On' : 'Paused'}</span>
                  </label>
                </div>

                <div className="schedule__meta">
                  {drive && (
                    <span>
                      <ProviderIcon provider={drive.catalogueKey ?? drive.provider} size={15} />
                      {catalogueEntry(drive.catalogueKey ?? '')?.label ?? drive.provider} ·{' '}
                      {drive.nickname}
                    </span>
                  )}

                  <span>{schedule.enabled ? `Next ${when(schedule.nextRunAt)}` : 'Paused'}</span>

                  {schedule.lastRunAt && (
                    <span data-status={schedule.lastStatus ?? undefined}>
                      Last run {when(schedule.lastRunAt)}
                      {schedule.lastMessage ? ` — ${schedule.lastMessage}` : ''}
                    </span>
                  )}
                  {!schedule.lastRunAt && <span>Has not run yet</span>}
                </div>

                <div className="schedule__actions">
                  <button
                    type="button"
                    className="clay-button"
                    disabled={busyId === schedule.id}
                    // So somebody can find out now whether a job works, rather
                    // than at 2am tomorrow.
                    title="Run it now. This does not change when it next runs on its own."
                    onClick={() => void runNow(schedule)}
                  >
                    {busyId === schedule.id ? 'Running…' : 'Run now'}
                  </button>

                  <button
                    type="button"
                    className="clay-button"
                    style={{ color: 'var(--danger)' }}
                    onClick={() => setDeleting(schedule)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {schedules?.length === 0 && (
        <section className="clay" style={{ padding: 'clamp(1.5rem, 4vw, 2.5rem)', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-muted)', margin: 0, lineHeight: 1.6 }}>
            Nothing scheduled. A nightly sync keeps search and the duplicate finder current without
            you having to remember.
          </p>
        </section>
      )}

      <form className="clay schedule-new" onSubmit={(event) => void create(event)}>
        <h2 style={{ fontSize: '1.05rem', margin: 0 }}>New schedule</h2>

        <div className="schedule-new__row">
          <label>
            <span>Name</span>
            <input
              required
              className="clay-sunken"
              placeholder="Nightly sync"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          <label>
            <span>Drive to sync</span>
            <select
              className="clay-sunken"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.nickname}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="schedule-new__row">
          <label>
            <span>How often</span>
            <select
              className="clay-sunken"
              value={every}
              onChange={(event) => setEvery(event.target.value as Every)}
            >
              <option value="hourly">Every hour</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month</option>
            </select>
          </label>

          {every === 'weekly' && (
            <label>
              <span>Day</span>
              <select
                className="clay-sunken"
                value={weekday}
                onChange={(event) => setWeekday(Number(event.target.value))}
              >
                {DAYS.map((day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                ))}
              </select>
            </label>
          )}

          {every === 'monthly' && (
            <label>
              <span>Day of the month</span>
              <input
                type="number"
                min={1}
                max={31}
                className="clay-sunken"
                value={dayOfMonth}
                onChange={(event) => setDayOfMonth(Number(event.target.value))}
              />
            </label>
          )}

          {/* Meaningless for an hourly job, which runs at the same minute past
              every hour whatever hour you name. */}
          {every !== 'hourly' && (
            <label>
              <span>Hour</span>
              <input
                type="number"
                min={0}
                max={23}
                className="clay-sunken"
                value={hour}
                onChange={(event) => setHour(Number(event.target.value))}
              />
            </label>
          )}

          <label>
            <span>Minute</span>
            <input
              type="number"
              min={0}
              max={59}
              className="clay-sunken"
              value={minute}
              onChange={(event) => setMinute(Number(event.target.value))}
            />
          </label>
        </div>

        <div className="schedule-new__foot">
          <span>
            {every === 'monthly' && dayOfMonth > 28
              ? `On the ${dayOfMonth}${ordinal(dayOfMonth)}, or the last day in a shorter month.`
              : 'Runs on Orbit’s clock, not the provider’s.'}
          </span>
          <button type="submit" className="clay-button clay-button--accent" disabled={!accounts.length}>
            Create
          </button>
        </div>
      </form>

      {deleting && (
        <ConfirmDialog
          title={`Delete “${deleting.name}”?`}
          description="The job stops. Nothing it has already done is undone."
          confirmLabel="Delete schedule"
          destructive
          onConfirm={() => void remove(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
