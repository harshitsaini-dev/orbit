import { useCallback, useEffect, useState } from 'react';
import type { AccessLevel, DriveMember, PublicAccount } from '@orbit/shared-types';
import { ApiError, api } from '../lib/api.js';

/**
 * Who else may use one drive.
 *
 * Per drive rather than per Orbit account, because that is the distinction that
 * matters: bringing somebody in to work on the team bucket should not show them
 * the personal Drive connected next to it.
 *
 * There is no invitation link to send on. Adding an address is enough — that
 * person signs in with their own address and their own code, and receiving the
 * code is what proves the invitation reached the right inbox. A link in an
 * email proves only that somebody has the link.
 */

const LEVELS: Array<{ value: AccessLevel; label: string; detail: string }> = [
  { value: 'read', label: 'Read', detail: 'Open, download and search. Changes nothing.' },
  { value: 'write', label: 'Write', detail: 'And upload, rename, and make folders. Cannot delete.' },
  { value: 'full', label: 'Full', detail: 'And delete files, and publish share links.' },
  { value: 'admin', label: 'Admin', detail: 'And add other people to this drive.' },
];

function levelLabel(level: AccessLevel): string {
  return LEVELS.find((l) => l.value === level)?.label ?? level;
}

export function DriveMembers({ account }: { account: PublicAccount }) {
  const [members, setMembers] = useState<DriveMember[] | null>(null);
  const [email, setEmail] = useState('');
  const [level, setLevel] = useState<AccessLevel>('read');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { members: rows } = await api<{ members: DriveMember[] }>(
      `/api/accounts/${account.id}/members`,
    );
    setMembers(rows);
  }, [account.id]);

  useEffect(() => {
    void load().catch(() => setMembers([]));
  }, [load]);

  async function add(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await api(`/api/accounts/${account.id}/members`, {
        method: 'POST',
        body: { email: email.trim(), level },
      });
      setEmail('');
      setLevel('read');
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? 'That address already has access to this drive'
          : 'Could not add that address',
      );
    } finally {
      setBusy(false);
    }
  }

  async function change(member: DriveMember, next: AccessLevel): Promise<void> {
    // Applied optimistically: the row is a select, and a select that snaps back
    // half a second after you change it reads as a bug rather than as loading.
    setMembers((rows) =>
      rows ? rows.map((r) => (r.userId === member.userId ? { ...r, level: next } : r)) : rows,
    );

    try {
      await api(`/api/accounts/${account.id}/members/${member.userId}`, {
        method: 'PATCH',
        body: { level: next },
      });
    } catch {
      setError('Could not change that level');
      await load();
    }
  }

  async function remove(member: DriveMember): Promise<void> {
    setMembers((rows) => rows ? rows.filter((r) => r.userId !== member.userId) : rows);

    try {
      await api(`/api/accounts/${account.id}/members/${member.userId}`, { method: 'DELETE' });
    } catch {
      setError('Could not remove that person');
      await load();
    }
  }

  return (
    <div className="drive-members">
      <div className="drive-members__head">
        <strong>People</strong>
        <span>
          {members === null
            ? 'Loading…'
            : members.length === 0
              ? 'Only you'
              : `${members.length} ${members.length === 1 ? 'person' : 'people'} besides you`}
        </span>
      </div>

      {members && members.length > 0 && (
        <ul className="drive-members__list">
          {members.map((member) => (
            <li key={member.userId}>
              <span className="drive-members__who">
                <strong>{member.displayName ?? member.email}</strong>
                <span>
                  {member.displayName ? member.email : null}
                  {/* Invited is not the same as arrived, and an admin looking at
                      this list needs to know which one they are looking at. */}
                  {member.joinedAt === null && (
                    <em className="drive-members__pending">has not signed in yet</em>
                  )}
                </span>
              </span>

              <select
                className="clay-sunken drive-members__level"
                aria-label={`Access level for ${member.email}`}
                value={member.level}
                onChange={(event) => void change(member, event.target.value as AccessLevel)}
              >
                {LEVELS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>

              <button
                type="button"
                className="clay-button"
                style={{ color: 'var(--danger)' }}
                title={`Remove ${member.email} from this drive. Their files elsewhere are untouched.`}
                onClick={() => void remove(member)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="drive-members__add" onSubmit={(event) => void add(event)}>
        <input
          type="email"
          required
          className="clay-sunken"
          placeholder="name@example.com"
          aria-label="Email address to give access to"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />

        <select
          className="clay-sunken"
          aria-label="Access level"
          value={level}
          onChange={(event) => setLevel(event.target.value as AccessLevel)}
        >
          {LEVELS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <button type="submit" className="clay-button clay-button--accent" disabled={busy}>
          {busy ? 'Adding…' : 'Add'}
        </button>
      </form>

      <p className="drive-members__hint">
        {LEVELS.find((l) => l.value === level)?.detail} They sign in with their own address and
        their own code — nothing about your sign-in is shared.
      </p>

      {error && (
        <p role="alert" style={{ color: 'var(--danger)', fontSize: 13, margin: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}

export { levelLabel };
