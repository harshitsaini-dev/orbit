import type { CSSProperties } from 'react';

/**
 * Provider marks.
 *
 * These are **original glyphs**, not the vendors' logos. Each uses the service's
 * own brand colour and a simple form that evokes it, so the list is scannable at
 * a glance, but nothing here reproduces a trademarked mark. Shipping copies of
 * other companies' logos in a public repository is a licensing question, and one
 * worth not having.
 *
 * If exact brand marks are wanted later, each vendor publishes them under brand
 * guidelines — see docs/07-provider-icons.md for where, and what each licence
 * requires.
 */

export type ProviderIconKey =
  | 'google_drive'
  | 'onedrive'
  | 'dropbox'
  | 'mega'
  | 'pcloud'
  | 'gcs'
  | 'azure_blob'
  | 'bunny'
  | 'aws_s3'
  | 'cloudflare_r2'
  | 'supabase_storage'
  | 'digitalocean_spaces'
  | 'backblaze_b2'
  | 's3_other'
  | 's3';

interface Mark {
  /** The service's own brand colour, used as the glyph's fill. */
  colour: string;
  render: (id: string) => JSX.Element;
}

const triangleStack = (colour: string) => (
  <>
    <path d="M12 3.5 20.5 18h-5.4L6.6 3.5z" fill={colour} opacity="0.95" />
    <path d="M9.9 8.6 3.5 20h11.2l-2.9-5.1z" fill={colour} opacity="0.55" />
  </>
);

const cloudPath = 'M6.6 19h11a4.4 4.4 0 0 0 .5-8.8A6 6 0 0 0 6.9 8.6 3.9 3.9 0 0 0 6.6 19z';

const MARKS: Record<ProviderIconKey, Mark> = {
  google_drive: { colour: '#2f9e5f', render: () => triangleStack('#2f9e5f') },

  onedrive: {
    colour: '#1a73c8',
    render: () => (
      <>
        <path d={cloudPath} fill="#1a73c8" opacity="0.9" />
        <circle cx="9" cy="11.5" r="3.2" fill="#1a73c8" opacity="0.5" />
      </>
    ),
  },

  dropbox: {
    colour: '#0d6efd',
    render: () => (
      <>
        <path d="M7 3.5 12 7l-5 3.5L2 7z" fill="#0d6efd" />
        <path d="M17 3.5 22 7l-5 3.5L12 7z" fill="#0d6efd" opacity="0.8" />
        <path d="M7 11.5 12 15l-5 3.5L2 15z" fill="#0d6efd" opacity="0.6" />
        <path d="M17 11.5 22 15l-5 3.5L12 15z" fill="#0d6efd" opacity="0.45" />
      </>
    ),
  },

  mega: {
    colour: '#d9272e',
    render: () => (
      <>
        <circle cx="12" cy="12" r="9.2" fill="#d9272e" opacity="0.16" />
        <path d="M6 16.5v-9l6 5 6-5v9" stroke="#d9272e" strokeWidth="2.1" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },

  pcloud: {
    colour: '#00a3e0',
    render: () => (
      <>
        <path d={cloudPath} fill="#00a3e0" opacity="0.85" />
        <path d="M12 9.2v6M9.4 12.2 12 9.2l2.6 3" stroke="#fff" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },

  gcs: {
    colour: '#3f7ee6',
    render: () => (
      <>
        <path d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4z" fill="#3f7ee6" opacity="0.22" />
        <path d="M12 6.6 16.8 9.4v5.2L12 17.4 7.2 14.6V9.4z" fill="#3f7ee6" />
      </>
    ),
  },

  azure_blob: {
    colour: '#2f8fd8',
    render: () => (
      <>
        <path d="M9.6 3.6h6.1L21 17.2H12z" fill="#2f8fd8" opacity="0.9" />
        <path d="M8.4 8.2 3 17.2l9.1 3.2 6.4-3.2z" fill="#2f8fd8" opacity="0.45" />
      </>
    ),
  },

  bunny: {
    colour: '#f28c1c',
    render: () => (
      <>
        <path d="M8.4 10.4c-.6-2.6-.4-5.2.6-5.5 1-.3 2.2 1.6 2.6 4.1" stroke="#f28c1c" strokeWidth="1.9" fill="none" strokeLinecap="round" />
        <path d="M15.6 10.4c.6-2.6.4-5.2-.6-5.5-1-.3-2.2 1.6-2.6 4.1" stroke="#f28c1c" strokeWidth="1.9" fill="none" strokeLinecap="round" />
        <ellipse cx="12" cy="15.4" rx="5.4" ry="4.8" fill="#f28c1c" />
      </>
    ),
  },

  aws_s3: {
    colour: '#e8912d',
    render: () => (
      <>
        <ellipse cx="12" cy="6.4" rx="7.4" ry="3.1" fill="#e8912d" />
        <path d="M4.6 6.4v11.2c0 1.7 3.3 3.1 7.4 3.1s7.4-1.4 7.4-3.1V6.4" fill="#e8912d" opacity="0.4" />
        <path d="M4.6 12c0 1.7 3.3 3.1 7.4 3.1s7.4-1.4 7.4-3.1" stroke="#e8912d" strokeWidth="1.5" fill="none" />
      </>
    ),
  },

  cloudflare_r2: {
    colour: '#f26522',
    render: () => (
      <>
        <path d={cloudPath} fill="#f26522" opacity="0.9" />
        <path d="M4 15.4h9.6" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
      </>
    ),
  },

  supabase_storage: {
    colour: '#35b57c',
    render: () => (
      <>
        <path d="M12.6 2.6 4.4 12.7c-.5.6-.1 1.5.7 1.5h5.6v7.2l8.2-10.1c.5-.6.1-1.5-.7-1.5h-5.6z" fill="#35b57c" />
      </>
    ),
  },

  digitalocean_spaces: {
    colour: '#0a7ff5',
    render: () => (
      <>
        <path d="M12 2.8a9.2 9.2 0 0 0 0 18.4v-4.4a4.8 4.8 0 1 1 4.8-4.8H21A9.2 9.2 0 0 0 12 2.8z" fill="#0a7ff5" opacity="0.85" />
        <rect x="9.6" y="14.4" width="4.2" height="4.2" rx="0.6" fill="#0a7ff5" />
      </>
    ),
  },

  backblaze_b2: {
    colour: '#e01f26',
    render: () => (
      <>
        <path d="M4.4 5.2h8.4a3.3 3.3 0 0 1 0 6.6H4.4z" fill="#e01f26" />
        <path d="M4.4 11.8h9.6a3.4 3.4 0 0 1 0 6.9H4.4z" fill="#e01f26" opacity="0.55" />
      </>
    ),
  },

  s3_other: {
    colour: '#8a93a8',
    render: () => (
      <>
        <ellipse cx="12" cy="6.4" rx="7.4" ry="3.1" fill="#8a93a8" />
        <path d="M4.6 6.4v11.2c0 1.7 3.3 3.1 7.4 3.1s7.4-1.4 7.4-3.1V6.4" fill="#8a93a8" opacity="0.35" />
      </>
    ),
  },

  s3: {
    colour: '#8a93a8',
    render: () => (
      <>
        <ellipse cx="12" cy="6.4" rx="7.4" ry="3.1" fill="#8a93a8" />
        <path d="M4.6 6.4v11.2c0 1.7 3.3 3.1 7.4 3.1s7.4-1.4 7.4-3.1V6.4" fill="#8a93a8" opacity="0.35" />
      </>
    ),
  },
};

/** Anything unrecognised still gets a mark rather than a gap in the row. */
const FALLBACK: Mark = {
  colour: 'var(--text-muted)',
  render: () => (
    <>
      <path d={cloudPath} fill="currentColor" opacity="0.45" />
    </>
  ),
};

export function providerColour(key: string): string {
  return (MARKS[key as ProviderIconKey] ?? FALLBACK).colour;
}

export function ProviderIcon({
  provider,
  size = 24,
  style,
}: {
  provider: string;
  size?: number;
  style?: CSSProperties;
}) {
  const mark = MARKS[provider as ProviderIconKey] ?? FALLBACK;

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      role="img"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flexShrink: 0, color: 'var(--text-muted)', ...style }}
    >
      {mark.render(provider)}
    </svg>
  );
}
