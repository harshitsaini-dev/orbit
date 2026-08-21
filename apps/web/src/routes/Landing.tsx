import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CatalogueEntry, UnavailableProvider } from '@orbit/shared-types';
import { BrandMark } from '../components/BrandMark.js';
import { InstallButton } from '../components/InstallButton.js';
import { OrbitHero } from '../components/OrbitHero.js';
import { ProviderIcon } from '../components/ProviderIcon.js';
import { ThemePicker } from '../components/ThemePicker.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';

interface CatalogueResponse {
  entries: CatalogueEntry[];
  unavailable: UnavailableProvider[];
}

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

const FEATURES = [
  {
    title: 'One workspace, every account',
    body: 'Browse Drive, Dropbox, OneDrive and your buckets side by side, including several accounts from the same provider. Recent, Starred and Shared read across all of them at once.',
  },
  {
    title: 'Your files never move',
    body: 'Orbit stores metadata and an encrypted token. The bytes stay in your own accounts and are streamed on demand, so nothing is copied anywhere new.',
  },
  {
    title: 'Search that reaches everything',
    body: 'Search runs at the provider over every file in the account, not over what happens to be loaded — with filters for type, date, size and starred, and results that say where each file lives.',
  },
  {
    title: 'Preview without leaving',
    body: 'Photos, video, audio, PDFs and text open in Orbit’s own viewer. Video seeks properly, images fit then zoom, and no provider URL ever reaches your browser.',
  },
  {
    title: 'Upload anywhere',
    body: 'Drag files or a whole folder in. Uploads are chunked and resumable, with live progress, and land in whichever account you choose.',
  },
  {
    title: 'Share on your own domain',
    body: 'A public link points at Orbit, never at the underlying drive, with a preview page and a QR code.',
  },
];

const STEPS = [
  { n: 1, title: 'Sign in with your email', body: 'A six-digit code, no password to remember or leak.' },
  { n: 2, title: 'Connect your accounts', body: 'Authorise each provider once. Orbit only ever holds an encrypted token.' },
  { n: 3, title: 'Work in one place', body: 'Browse, search, upload and share across all of them together.' },
];

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
  const providerCount = catalogue?.entries.length ?? 0;

  // Local mode has no sign-in at all, so the call to action is the workspace.
  const primary = mode === 'hosted' ? { to: '/login', label: 'Create your workspace' } : { to: '/quota', label: 'Connect an account' };

  return (
    <div className="landing">
      <header className="landing__bar">
        <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <BrandMark size={28} />
          <strong style={{ fontSize: 20, letterSpacing: '-0.03em' }}>Orbit</strong>
        </span>

        <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <ThemePicker />
          <InstallButton style={{ padding: '0.4rem 0.9rem', fontSize: 13 }} />
          {mode === 'hosted' && (
            <Link to="/login" className="clay-button" style={{ padding: '0.42rem 1.1rem', fontSize: 14, textDecoration: 'none' }}>
              Sign in
            </Link>
          )}
        </span>
      </header>

      <section className="clay landing__hero">
        <div className="landing__hero-copy">
          <span className="landing__eyebrow">Multi-cloud file manager</span>
          <h1>
            One workspace for <em>every cloud</em> you own.
          </h1>
          <p>
            Orbit puts every cloud account you have behind a single interface — browse, search,
            upload and share across all of them without switching tabs. Your files stay exactly
            where they are.
          </p>

          <div className="landing__cta">
            <Link to={primary.to} className="clay-button clay-button--accent" style={{ padding: '0.62rem 1.5rem', fontSize: 15, textDecoration: 'none' }}>
              {primary.label}
            </Link>
            <InstallButton style={{ padding: '0.62rem 1.3rem', fontSize: 15 }} />
          </div>

          <p className="landing__note">
            Free, open source, and self-hostable. {providerCount > 0 && `${providerCount} services supported.`}
          </p>
        </div>

        <div className="landing__hero-art">
          <OrbitHero />
        </div>
      </section>

      <section className="landing__features">
        {FEATURES.map((feature) => (
          <article key={feature.title} className="clay landing__feature">
            <h2>{feature.title}</h2>
            <p>{feature.body}</p>
          </article>
        ))}
      </section>

      <section className="clay landing__steps">
        <h2>Getting started</h2>
        <ol>
          {STEPS.map((step) => (
            <li key={step.n}>
              <span className="landing__step-number" aria-hidden="true">
                {step.n}
              </span>
              <span>
                <strong>{step.title}</strong>
                <span>{step.body}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className="clay landing__providers">
        <h2>Supported providers</h2>
        {error && <p style={{ color: 'var(--danger)' }}>API unreachable: {error}</p>}
        {!catalogue && !error && <p style={{ color: 'var(--text-muted)' }}>Loading…</p>}

        {catalogue &&
          GROUPS.map((group) => (
            <div key={group.title} style={{ marginTop: '1.25rem' }}>
              <h3>{group.title}</h3>
              <ul className="landing__provider-grid">
                {group.keys.map((key) => {
                  const entry = byKey.get(key);
                  if (!entry) return null;
                  return (
                    <li key={key} className="clay-sunken">
                      <ProviderIcon provider={entry.key} size={26} />
                      <span>
                        <strong>{entry.label}</strong>
                        <span>{entry.blurb}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}

        {catalogue && catalogue.unavailable.length > 0 && (
          <div style={{ marginTop: '1.75rem' }}>
            <h3>Not supported</h3>
            <ul className="landing__provider-grid landing__provider-grid--muted">
              {catalogue.unavailable.map((entry) => (
                <li key={entry.key}>
                  <span>
                    <strong>{entry.label}</strong>
                    <span>{entry.reason}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="clay landing__closing">
        <h2>Ready when you are</h2>
        <p>
          Connect the first account in about a minute. Nothing is copied, nothing is charged, and
          you can disconnect at any time.
        </p>
        <div className="landing__cta">
          <Link to={primary.to} className="clay-button clay-button--accent" style={{ padding: '0.62rem 1.5rem', fontSize: 15, textDecoration: 'none' }}>
            {primary.label}
          </Link>
          {mode === 'hosted' && (
            <Link to="/login" className="clay-button" style={{ padding: '0.62rem 1.3rem', fontSize: 15, textDecoration: 'none' }}>
              I already have a workspace
            </Link>
          )}
        </div>
      </section>

      <footer className="landing__footer">
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <BrandMark size={20} />
          Orbit
        </span>
        <span>Your files stay in your own accounts.</span>
      </footer>
    </div>
  );
}
