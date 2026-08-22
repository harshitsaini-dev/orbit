import { useCallback, useEffect, useState } from 'react';
import { ConfirmDialog } from '../components/NameDialog.js';
import { FileListSkeleton } from '../components/Skeleton.js';
import { StatusScreen, statusKindFor } from '../components/StatusScreen.js';
import { ApiError, api } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';

/**
 * The console for whoever runs this instance.
 *
 * What is absent is as much the point as what is here. There is no way to
 * browse somebody's files, open one, or see what is in their drives — only how
 * many they have connected and how much each provider says is in them. Orbit's
 * promise is that it holds nothing, and an admin console that walked around
 * that would make the promise false with the operator holding the key.
 */

interface Overview {
  users: number;
  accounts: number;
  shares: number;
  activeSessions: number;
  storedBytes: number;
}

interface AdminUser {
  id: string;
  email: string;
  displayName: string | null;
  role: 'user' | 'superadmin';
  accounts: number;
  lastSeenAt: string | null;
  createdAt: string;
}

interface Event {
  id: string;
  action: string;
  actorEmail: string | null;
  summary: string | null;
  createdAt: string;
}

function when(iso: string | null): string {
  if (!iso) return 'never';
  const days = (Date.now() - new Date(iso).getTime()) / 86_400_000;
  if (days < 1) return 'today';
  if (days < 30) return `${Math.round(days)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
}

export function Admin() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AdminUser | null>(null);

  const load = useCallback(async () => {
    try {
      const [counts, people, activity] = await Promise.all([
        api<Overview>('/api/admin/overview'),
        api<{ users: AdminUser[] }>('/api/admin/users'),
        api<{ entries: Event[] }>('/api/admin/activity'),
      ]);

      setOverview(counts);
      setUsers(people.users);
      setEvents(activity.entries);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Could not load the console'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function changeRole(person: AdminUser, role: AdminUser['role']): Promise<void> {
    setNotice(null);

    try {
      await api(`/api/admin/users/${person.id}`, { method: 'PATCH', body: { role } });
      await load();
    } catch (err) {
      setNotice(
        err instanceof ApiError
          ? err.message
          : 'Could not change that role',
      );
    }
  }

  async function remove(person: AdminUser): Promise<void> {
    setNotice(null);

    try {
      await api(`/api/admin/users/${person.id}`, { method: 'DELETE' });
      setRemoving(null);
      await load();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'Could not remove that account');
    }
  }

  if (error) {
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
        <h1 style={{ fontSize: '1.4rem', margin: 0 }}>Admin</h1>
        <p style={{ color: 'var(--text-muted)', margin: '0.4rem 0 0', lineHeight: 1.6 }}>
          This instance, not anybody’s files. You can see how many drives somebody has connected
          and what each provider reports is in them — <strong>not what is in them</strong>. Orbit
          holds no files, and this console does not get an exception.
        </p>

        {overview && (
          <ul className="admin-stats">
            <li>
              <strong>{overview.users.toLocaleString()}</strong>
              <span>people</span>
            </li>
            <li>
              <strong>{overview.accounts.toLocaleString()}</strong>
              <span>drives connected</span>
            </li>
            <li>
              <strong>{formatBytes(overview.storedBytes)}</strong>
              <span>stored at the providers</span>
            </li>
            <li>
              <strong>{overview.shares.toLocaleString()}</strong>
              <span>live share links</span>
            </li>
            <li>
              <strong>{overview.activeSessions.toLocaleString()}</strong>
              <span>signed in now</span>
            </li>
          </ul>
        )}
      </section>

      {notice && (
        <p role="alert" className="clay" style={{ padding: '0.8rem 1.1rem', margin: 0, color: 'var(--danger)' }}>
          {notice}
        </p>
      )}

      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
        <h2 style={{ fontSize: '1.1rem', margin: 0 }}>People</h2>

        {users === null && (
          <div style={{ marginTop: '1rem' }}>
            <FileListSkeleton rows={4} />
          </div>
        )}

        <ul className="admin-users">
          {users?.map((person) => (
            <li key={person.id}>
              <span className="admin-users__who">
                <strong>{person.displayName ?? person.email}</strong>
                <span>
                  {person.displayName ? `${person.email} · ` : ''}
                  {person.accounts} {person.accounts === 1 ? 'drive' : 'drives'} · last seen{' '}
                  {when(person.lastSeenAt)}
                </span>
              </span>

              <select
                className="clay-sunken"
                aria-label={`Role for ${person.email}`}
                value={person.role}
                onChange={(event) =>
                  void changeRole(person, event.target.value as AdminUser['role'])
                }
              >
                <option value="user">User</option>
                <option value="superadmin">Admin</option>
              </select>

              <button
                type="button"
                className="clay-button"
                style={{ color: 'var(--danger)' }}
                onClick={() => setRemoving(person)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
        <h2 style={{ fontSize: '1.1rem', margin: 0 }}>Recent activity</h2>

        {events.length === 0 ? (
          <p className="share-hint" style={{ marginTop: '0.6rem' }}>
            Nothing recorded yet. Deletions, moves, published links and access changes appear here.
          </p>
        ) : (
          <div className="drive-activity" style={{ border: 0, paddingTop: '0.6rem' }}>
            <ul>
              {events.map((event) => (
                <li key={event.id}>
                  <span>{event.summary ?? event.action}</span>
                  <span>
                    {event.actorEmail ?? 'a removed account'} · {when(event.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.email}?`}
          description="Their connected drives, sessions and collections go with them. The files themselves stay where they are, in the accounts they belong to — Orbit never had them. What they did on a shared drive stays in its history, with the name gone."
          confirmLabel="Remove account"
          destructive
          onConfirm={() => void remove(removing)}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}
