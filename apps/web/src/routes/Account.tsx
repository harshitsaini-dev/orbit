import { useEffect, useRef, useState } from 'react';
import type { PublicAccount, PublicUser, ThemeMode } from '@orbit/shared-types';
import { AllocationSettings } from '../components/AllocationSettings.js';
import { Avatar } from '../components/Avatar.js';
import { api, ApiError } from '../lib/api.js';
import { toAvatarDataUrl } from '../lib/image.js';
import { useAuth } from '../lib/auth.js';
import { ACCENTS, useTheme } from '../lib/theme.js';

export function Account() {
  const { user, refresh } = useAuth();
  const { setTheme, setAccent } = useTheme();

  const [name, setName] = useState(user?.displayName ?? '');
  // Loaded here rather than passed in: the allocation panel needs the weights
  // and the free space, which the profile does not carry.
  const [accounts, setAccounts] = useState<PublicAccount[]>([]);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<{ accounts: PublicAccount[] }>('/api/accounts', { signal: controller.signal })
      .then(({ accounts: rows }) => setAccounts(rows))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    setName(user?.displayName ?? '');
  }, [user?.displayName]);

  if (!user) return null;

  async function save(changes: Partial<PublicUser> & { avatar?: string | null }) {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      await api<{ user: PublicUser }>('/api/profile', { method: 'PATCH', body: changes });
      await refresh();
      setStatus('Saved.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save your profile');
    } finally {
      setSaving(false);
    }
  }

  async function pickAvatar(file: File | undefined) {
    if (!file) return;
    setError(null);
    setStatus(null);
    try {
      // Resized in the browser, so any photo works rather than being rejected.
      const avatar = await toAvatarDataUrl(file);
      await save({ avatar });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that image');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div style={{ display: 'grid', gap: '1.5rem' }}>
      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)', display: 'grid', gap: '1.25rem' }}>
        <div>
          <h1 className="page-title">Your profile</h1>
          <p style={{ color: 'var(--text-muted)', marginTop: '0.4rem' }}>
            How you appear inside Orbit. None of this is shared with any provider.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '1.1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <Avatar user={user} size={76} />

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="clay-button"
              style={{ padding: '0.45rem 1rem', fontSize: 13 }}
              disabled={saving}
              onClick={() => fileRef.current?.click()}
            >
              {user.avatar ? 'Change picture' : 'Upload picture'}
            </button>

            {user.avatar && (
              <button
                type="button"
                className="clay-button"
                style={{ padding: '0.45rem 1rem', fontSize: 13, color: 'var(--danger)' }}
                disabled={saving}
                onClick={() => void save({ avatar: null })}
              >
                Remove
              </button>
            )}

            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              aria-label="Profile picture"
              style={{ display: 'none' }}
              onChange={(event) => void pickAvatar(event.target.files?.[0])}
            />
          </div>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save({ displayName: name });
          }}
          style={{ display: 'grid', gap: '0.5rem', maxWidth: 420 }}
        >
          <label htmlFor="displayName" style={{ fontSize: 14, fontWeight: 600 }}>
            Display name
          </label>
          <input
            id="displayName"
            value={name}
            maxLength={80}
            placeholder={user.email}
            onChange={(event) => setName(event.target.value)}
            className="clay-sunken"
            style={{
              border: 0,
              padding: '0.75rem 1rem',
              font: 'inherit',
              color: 'var(--text)',
              borderRadius: 'var(--radius-sm)',
            }}
          />
          <button
            type="submit"
            className="clay-button clay-button--accent"
            style={{ justifySelf: 'start', padding: '0.5rem 1.25rem', fontSize: 14 }}
            disabled={saving || name === (user.displayName ?? '')}
          >
            {saving ? 'Saving…' : 'Save name'}
          </button>
        </form>

        <div style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Email</span>
          <span style={{ color: 'var(--text-muted)' }}>{user.email}</span>
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            Sign-in codes go here. It cannot be changed from this screen.
          </span>
        </div>

        {status && <p style={{ color: 'var(--success)', margin: 0, fontSize: 14 }}>{status}</p>}
        {error && (
          <p role="alert" style={{ color: 'var(--danger)', margin: 0, fontSize: 14 }}>
            {error}
          </p>
        )}
      </section>

      {user && (
        <AllocationSettings
          strategy={user.allocationStrategy}
          accounts={accounts}
          onChanged={() => void refresh()}
        />
      )}

      <section
        className="clay"
        aria-labelledby="appearance-heading"
        data-testid="appearance"
        style={{ padding: 'clamp(1.25rem, 3vw, 2rem)', display: 'grid', gap: '1rem' }}
      >
        <div>
          <h2 id="appearance-heading" style={{ fontSize: '1.1rem' }}>
            Appearance
          </h2>
          <p style={{ color: 'var(--text-muted)', marginTop: '0.3rem', fontSize: 14 }}>
            Saved to your account, so it follows you to another device.
          </p>
        </div>

        <div style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Theme</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['light', 'system', 'dark'] as ThemeMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className="clay-button"
                aria-pressed={user.theme === mode}
                disabled={saving}
                onClick={() => {
                  setTheme(mode);
                  void save({ theme: mode });
                }}
                style={{
                  padding: '0.4rem 1rem',
                  fontSize: 13,
                  boxShadow: user.theme === mode ? 'var(--shadow-clay-inset)' : 'var(--shadow-clay)',
                }}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Accent</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {ACCENTS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-label={`Accent ${option.name}`}
                aria-pressed={user.accent === option.value}
                disabled={saving}
                onClick={() => {
                  setAccent(option.value);
                  void save({ accent: option.value });
                }}
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: '50%',
                  border: user.accent === option.value ? '2px solid var(--text)' : '2px solid transparent',
                  background: option.value,
                  cursor: 'pointer',
                }}
              />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
