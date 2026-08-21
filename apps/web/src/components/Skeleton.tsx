import type { CSSProperties } from 'react';

/**
 * Placeholder shapes shown while data is on its way.
 *
 * They are sized to match what replaces them, so the layout does not jump when
 * the real content lands — a shimmer that is the wrong height is worse than a
 * plain "Loading…", because it moves everything twice.
 */
export function Skeleton({
  width = '100%',
  height = 14,
  radius = 'var(--radius-sm)',
  style,
}: {
  width?: number | string;
  height?: number | string;
  radius?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className="skeleton"
      aria-hidden="true"
      style={{ width, height, borderRadius: radius, ...style }}
    />
  );
}

/** Rows shaped like the file list. */
export function FileListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <ul
      // Announced once rather than row by row; a screen reader does not want
      // eight identical "loading" messages.
      aria-busy="true"
      aria-label="Loading files"
      style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 4 }}
    >
      {Array.from({ length: rows }, (_, index) => (
        <li
          key={index}
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0.55rem 0.6rem' }}
        >
          <Skeleton width={18} height={18} radius="6px" />
          <Skeleton width={22} height={22} radius="6px" />
          {/* Varying widths, so it reads as a list of names rather than a table. */}
          <Skeleton width={`${38 + ((index * 13) % 34)}%`} height={13} />
          <span style={{ flex: 1 }} />
          <Skeleton width={54} height={11} />
          <Skeleton width={76} height={11} />
        </li>
      ))}
    </ul>
  );
}

/** Tiles shaped like the grid. */
export function FileGridSkeleton({ tiles = 12 }: { tiles?: number }) {
  return (
    <ul
      aria-busy="true"
      aria-label="Loading files"
      style={{
        listStyle: 'none',
        padding: 0,
        margin: 0,
        display: 'grid',
        gap: 12,
        gridTemplateColumns: 'repeat(auto-fill, minmax(clamp(130px, 22vw, 168px), 1fr))',
      }}
    >
      {Array.from({ length: tiles }, (_, index) => (
        <li key={index} className="clay-sunken" style={{ padding: 8, display: 'grid', gap: 8 }}>
          <Skeleton height="auto" style={{ aspectRatio: '1 / 1' }} />
          <Skeleton width={`${58 + ((index * 11) % 34)}%`} height={12} />
          <Skeleton width={44} height={10} />
        </li>
      ))}
    </ul>
  );
}

/** The account cards on the dashboard and the quota page. */
export function AccountCardsSkeleton({ cards = 2 }: { cards?: number }) {
  return (
    <ul
      aria-busy="true"
      aria-label="Loading accounts"
      style={{
        listStyle: 'none',
        padding: 0,
        margin: 0,
        display: 'grid',
        gap: 10,
        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
      }}
    >
      {Array.from({ length: cards }, (_, index) => (
        <li key={index} className="clay-sunken" style={{ padding: '0.95rem 1.05rem', display: 'grid', gap: 9 }}>
          <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Skeleton width={24} height={24} radius="50%" />
            <Skeleton width="62%" height={13} />
          </span>
          <Skeleton height={6} radius="var(--radius-pill)" />
          <Skeleton width="45%" height={11} />
        </li>
      ))}
    </ul>
  );
}
