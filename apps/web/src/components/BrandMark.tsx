import { useId } from 'react';

/**
 * The Orbit mark: a hub with something in orbit around it, matching the favicon
 * and the three.js hero. The gradient ids are per-instance, so two marks on one
 * page cannot capture each other's fills.
 */
export function BrandMark({ size = 26 }: { size?: number }) {
  const id = useId().replace(/:/g, '');

  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      <defs>
        <radialGradient id={`${id}-core`} cx="36%" cy="30%" r="74%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="34%" stopColor="#b3c4ff" />
          <stop offset="100%" stopColor="var(--accent)" />
        </radialGradient>
        <linearGradient id={`${id}-orbit`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.95" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.35" />
        </linearGradient>
        {/* The orbit passes behind the hub at the top and in front at the
            bottom; the front copy is clipped to the hub's own disc so the two
            never stack into a visible seam outside it. */}
        <clipPath id={`${id}-lower`}>
          <rect x="0" y="32" width="64" height="32" />
        </clipPath>
        <clipPath id={`${id}-hub`}>
          <circle cx="32" cy="32" r="9.2" />
        </clipPath>
      </defs>

      <ellipse
        cx="32"
        cy="32"
        rx="26"
        ry="10.5"
        transform="rotate(-22 32 32)"
        fill="none"
        stroke={`url(#${id}-orbit)`}
        strokeWidth="3"
      />

      <circle cx="32" cy="32" r="9.2" fill={`url(#${id}-core)`} />

      <g clipPath={`url(#${id}-lower)`}>
        <g clipPath={`url(#${id}-hub)`}>
          <ellipse
            cx="32"
            cy="32"
            rx="26"
            ry="10.5"
            transform="rotate(-22 32 32)"
            fill="none"
            stroke={`url(#${id}-orbit)`}
            strokeWidth="3"
          />
        </g>
      </g>

      <circle cx="53.3" cy="19.5" r="4.6" fill="var(--text)" />
    </svg>
  );
}
