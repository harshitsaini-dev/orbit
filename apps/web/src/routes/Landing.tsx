import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CatalogueEntry } from '@orbit/shared-types';
import { BrandMark } from '../components/BrandMark.js';
import { InstallButton } from '../components/InstallButton.js';
import { OrbitHero } from '../components/OrbitHero.js';
import { ProviderIcon } from '../components/ProviderIcon.js';
import { ThemePicker } from '../components/ThemePicker.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';

const REPO = 'https://github.com/harshitsaini-dev/orbit';

// Fixed at load rather than per render: the year does not change while someone
// is reading, and recomputing it would defeat any caching of this tree.
const YEAR = new Date().getFullYear();

interface CatalogueResponse {
  entries: CatalogueEntry[];
}

const GROUPS: Array<{ title: string; keys: string[] }> = [
  { title: 'Cloud drives', keys: ['google_drive', 'onedrive', 'dropbox', 'pcloud'] },
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

/**
 * Sized rather than uniform. Six identical boxes read as a list of claims
 * nobody finishes; giving the two that matter most - one workspace, and files
 * that stay put - more room says which ones to read first, and the varied
 * shape gives the eye somewhere to go.
 */
const FEATURES = [
  {
    title: 'One workspace, every account',
    body: 'Browse Drive, Dropbox, OneDrive and your buckets side by side, including several accounts from the same provider. Recent, Starred and Shared read across all of them at once.',
    span: 'wide' as const,
    Icon: LayersGlyph,
  },
  {
    title: 'Your files never move',
    body: 'Orbit stores metadata and an encrypted token. The bytes stay in your own accounts and are streamed on demand, so nothing is copied anywhere new.',
    span: 'tall' as const,
    Icon: ShieldGlyph,
  },
  {
    title: 'Search that reaches everything',
    body: 'Search runs at the provider over every file in the account, not over what happens to be loaded — with filters for type, date, size and starred.',
    span: 'normal' as const,
    Icon: SearchGlyph,
  },
  {
    title: 'Preview without leaving',
    body: 'Photos, video, audio, PDFs and text open in Orbit’s own viewer. Video seeks properly, images fit then zoom, and no provider URL ever reaches your browser.',
    span: 'normal' as const,
    Icon: PlayGlyph,
  },
  {
    title: 'Upload anywhere',
    body: 'Drag files or a whole folder in. Uploads are chunked and resumable, with live progress, and land in whichever account you choose.',
    span: 'normal' as const,
    Icon: UploadGlyph,
  },
  {
    title: 'Share on your own domain',
    body: 'A public link points at Orbit, never at the underlying drive, with a preview page and a QR code.',
    span: 'full' as const,
    Icon: LinkGlyph,
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

      <section className="landing__features" id="features">
        {FEATURES.map(({ title, body, span, Icon }) => (
          <article key={title} className="clay landing__feature" data-span={span}>
            <span className="landing__feature-icon" aria-hidden="true">
              <Icon />
            </span>
            <h2>{title}</h2>
            <p>{body}</p>
          </article>
        ))}
      </section>

      <section className="clay landing__steps" id="how-it-works">
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

      <section className="clay landing__providers" id="providers">
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
        <div className="landing__footer-top">
          <div className="landing__footer-brand">
            <span className="landing__footer-mark">
              <BrandMark size={24} />
              <strong>Orbit</strong>
            </span>
            <p>
              One workspace for every cloud drive you own. Your files stay in the accounts they
              already live in — Orbit never keeps a copy.
            </p>
            <ThemePicker compact />
          </div>

          <nav className="landing__footer-links" aria-label="Footer">
            <div>
              <h3>Product</h3>
              <a href="#features">Features</a>
              <a href="#how-it-works">How it works</a>
              <a href="#providers">Providers</a>
            </div>

            <div>
              <h3>Get started</h3>
              <Link to={primary.to}>{primary.label}</Link>
              {mode === 'hosted' && <Link to="/login">Sign in</Link>}
              <Link to="/developer">Developer API</Link>
            </div>

            <div>
              <h3>Project</h3>
              <a href={REPO} target="_blank" rel="noreferrer noopener">
                Source on GitHub
              </a>
              <a href={`${REPO}/issues`} target="_blank" rel="noreferrer noopener">
                Report an issue
              </a>
              <a href={`${REPO}#readme`} target="_blank" rel="noreferrer noopener">
                Self-host it
              </a>
            </div>
          </nav>
        </div>

        <div className="landing__footer-bottom">
          <span>© {YEAR} Orbit</span>
          <span className="landing__footer-dot" aria-hidden="true" />
          <span>Open source</span>
          <span className="landing__footer-dot" aria-hidden="true" />
          <span>
            {providerCount > 0 ? `${providerCount} services supported` : 'Multi-cloud by design'}
          </span>
        </div>
      </footer>
    </div>
  );
}

// --- feature glyphs -------------------------------------------------------

const glyph = {
  viewBox: '0 0 24 24',
  width: 22,
  height: 22,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  style: { display: 'block' },
} as const;

function LayersGlyph() {
  return (
    <svg {...glyph}>
      <path d="M12 3.2 3.4 7.6 12 12l8.6-4.4z" />
      <path d="M3.4 12 12 16.4 20.6 12" />
      <path d="M3.4 16.4 12 20.8l8.6-4.4" />
    </svg>
  );
}

function ShieldGlyph() {
  return (
    <svg {...glyph}>
      <path d="M12 3.1 4.8 6v5.4c0 4.2 2.9 7.6 7.2 9.5 4.3-1.9 7.2-5.3 7.2-9.5V6z" />
      <path d="M9.4 12.1l1.9 1.9 3.4-3.7" />
    </svg>
  );
}

function SearchGlyph() {
  return (
    <svg {...glyph}>
      <circle cx="10.8" cy="10.8" r="6.4" />
      <path d="M15.5 15.5 20.6 20.6" />
    </svg>
  );
}

function PlayGlyph() {
  return (
    <svg {...glyph}>
      <rect x="3.2" y="4.8" width="17.6" height="14.4" rx="3" />
      <path d="M10.4 9.6 14.8 12l-4.4 2.4z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function UploadGlyph() {
  return (
    <svg {...glyph}>
      <path d="M12 16V4.6" />
      <path d="M7.8 8.8 12 4.6l4.2 4.2" />
      <path d="M4.4 15.4v3a1.6 1.6 0 0 0 1.6 1.6h12a1.6 1.6 0 0 0 1.6-1.6v-3" />
    </svg>
  );
}

function LinkGlyph() {
  return (
    <svg {...glyph}>
      <path d="M10.2 13.8a3.6 3.6 0 0 0 5.1 0l2.9-2.9a3.6 3.6 0 0 0-5.1-5.1l-1.3 1.3" />
      <path d="M13.8 10.2a3.6 3.6 0 0 0-5.1 0l-2.9 2.9a3.6 3.6 0 0 0 5.1 5.1l1.3-1.3" />
    </svg>
  );
}
