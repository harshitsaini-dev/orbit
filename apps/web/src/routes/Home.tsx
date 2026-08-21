import { useEffect, useState } from 'react';
import { OrbitHero } from '../components/OrbitHero.js';

interface ProviderInfo {
  id: string;
  displayName: string;
  authType: string;
}

const API_URL = import.meta.env.VITE_API_URL ?? '';

export function Home() {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_URL}/health/providers`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: { providers: ProviderInfo[] }) => setProviders(body.providers))
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setError(err.message);
      });
    return () => controller.abort();
  }, []);

  return (
    <div style={{ display: 'grid', gap: '1.5rem' }}>
      <section className="clay" style={{ padding: 'clamp(1.5rem, 4vw, 2.5rem)', overflow: 'hidden' }}>
        <OrbitHero />
        <h1 style={{ fontSize: 'clamp(1.75rem, 5vw, 2.75rem)', marginTop: '1rem' }}>
          One workspace for every cloud you own.
        </h1>
        <p style={{ color: 'var(--text-muted)', maxWidth: '52ch' }}>
          Connect Google Drive, OneDrive, Dropbox, MEGA, pCloud, or any S3-compatible
          bucket. Your files never leave your own accounts.
        </p>
        <button type="button" className="clay-button clay-button--accent" style={{ marginTop: '1rem' }}>
          Connect an account
        </button>
      </section>

      <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
        <h2 style={{ fontSize: '1.1rem', marginBottom: '0.75rem' }}>Provider support</h2>
        {error && <p style={{ color: 'var(--danger)' }}>API unreachable: {error}</p>}
        {!providers && !error && <p style={{ color: 'var(--text-muted)' }}>Loading…</p>}
        {providers && (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            {providers.map((provider) => (
              <li
                key={provider.id}
                className="clay-sunken"
                style={{ padding: '0.6rem 1rem', display: 'flex', justifyContent: 'space-between', gap: '1rem' }}
              >
                <span>{provider.displayName}</span>
                <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{provider.authType}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
