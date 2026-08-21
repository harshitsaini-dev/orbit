import { useEffect, useState } from 'react';
import type { CatalogueEntry, UnavailableProvider } from '@orbit/shared-types';
import { OrbitHero } from '../components/OrbitHero.js';
import { ProviderIcon } from '../components/ProviderIcon.js';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';

interface CatalogueResponse {
  entries: CatalogueEntry[];
  unavailable: UnavailableProvider[];
}

/** Grouped the way the connect dialog will group them in Phase 2. */
const GROUPS: Array<{ title: string; keys: string[] }> = [
  { title: 'Cloud drives', keys: ['google_drive', 'onedrive', 'dropbox', 'pcloud', 'mega'] },
  {
    title: 'Object storage',
    keys: [
      'aws_s3',
      'cloudflare_r2',
      'supabase_storage',
      'digitalocean_spaces',
      'backblaze_b2',
      'gcs',
      'azure_blob',
      'bunny',
      's3_other',
    ],
  },
];

function ProviderCard({ entry }: { entry: CatalogueEntry }) {
  return (
    <li
      className="clay-sunken"
      style={{ padding: '0.85rem 1.1rem', display: 'flex', gap: 12, alignItems: 'center' }}
    >
      <ProviderIcon provider={entry.key} size={26} />
      <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
        <span style={{ fontWeight: 600 }}>{entry.label}</span>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{entry.blurb}</span>
      </span>
    </li>
  );
}

const GROUP_HEADING: React.CSSProperties = {
  fontSize: 13,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--text-muted)',
};

/**
 * The public face of Orbit, shown to anyone not signed in. Signed-in users get
 * the dashboard at the same address instead - this page is about explaining
 * what Orbit is, which is not what someone with three connected drives needs.
 */
export function Landing() {
  const { mode } = useAuth();
  const [catalogue, setCatalogue] = useState<CatalogueResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<CatalogueResponse>('/api/catalogue', { signal: controller.signal })
      .then(setCatalogue)
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setError(err.message);
      });
    return () => controller.abort();
  }, []);

  const byKey = new Map((catalogue?.entries ?? []).map((entry) => [entry.key, entry]));

  return (
    <div
      style={{
        display: 'grid',
        gap: '1.5rem',
        maxWidth: 1000,
        margin: '0 auto',
        padding: 'clamp(1rem, 4vw, 3rem) clamp(0.75rem, 4vw, 2rem)',
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: 20, letterSpacing: '-0.03em' }}>Orbit</strong>
        {mode === 'hosted' && (
          <Link to="/login" className="clay-button" style={{ padding: '0.4rem 1.1rem', fontSize: 14, textDecoration: 'none' }}>
            Sign in
          </Link>
        )}
      </header>
      <section className="clay" style={{ padding: 'clamp(1.5rem, 4vw, 2.5rem)', overflow: 'hidden' }}>
        <div style={{ height: 'clamp(220px, 30vw, 340px)', margin: '-1rem -1rem 0' }}>
          <OrbitHero />
        </div>
        <h1 style={{ fontSize: 'clamp(1.75rem, 5vw, 2.75rem)', marginTop: '1rem' }}>
          One workspace for every cloud you own.
        </h1>
        <p style={{ color: 'var(--text-muted)', maxWidth: '52ch' }}>
          Browse, upload and share across every connected account — without your files ever leaving
          them.
        </p>
        {mode === 'hosted' ? (
          <Link
            to="/login"
            className="clay-button clay-button--accent"
            style={{ marginTop: '1rem', display: 'inline-block', textDecoration: 'none' }}
          >
            Sign in to get started
          </Link>
        ) : (
          <Link
            to="/quota"
            className="clay-button clay-button--accent"
            style={{ marginTop: '1rem', display: 'inline-block', textDecoration: 'none' }}
          >
            Connect an account
          </Link>
        )}
      </section>

      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
        <h2 style={{ fontSize: '1.1rem' }}>Supported providers</h2>
        {error && <p style={{ color: 'var(--danger)' }}>API unreachable: {error}</p>}
        {!catalogue && !error && <p style={{ color: 'var(--text-muted)' }}>Loading…</p>}

        {catalogue &&
          GROUPS.map((group) => (
            <div key={group.title} style={{ marginTop: '1.25rem' }}>
              <h3 style={GROUP_HEADING}>{group.title}</h3>
              <ul
                style={{
                  listStyle: 'none',
                  padding: 0,
                  margin: '0.6rem 0 0',
                  display: 'grid',
                  gap: 8,
                  gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
                }}
              >
                {group.keys.map((key) => {
                  const entry = byKey.get(key);
                  return entry ? <ProviderCard key={key} entry={entry} /> : null;
                })}
              </ul>
            </div>
          ))}

        {catalogue && catalogue.unavailable.length > 0 && (
          <div style={{ marginTop: '1.75rem' }}>
            <h3 style={GROUP_HEADING}>Not supported</h3>
            <ul style={{ listStyle: 'none', padding: 0, margin: '0.6rem 0 0', display: 'grid', gap: 8 }}>
              {catalogue.unavailable.map((entry) => (
                <li
                  key={entry.key}
                  style={{
                    padding: '0.85rem 1.1rem',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px dashed var(--border)',
                    display: 'grid',
                    gap: 2,
                  }}
                >
                  <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}>{entry.label}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{entry.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
