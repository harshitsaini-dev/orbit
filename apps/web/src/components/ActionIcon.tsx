/**
 * Small action glyphs.
 *
 * These are SVG rather than text characters on purpose: "☆" and "★" are
 * substituted from whatever font the platform has, and on several the outline
 * star renders as a solid one — which makes an unstarred file look starred.
 */

import type { SVGProps } from 'react';

const base: SVGProps<SVGSVGElement> = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.9,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: 'false',
  style: { display: 'block' },
};

const STAR = 'M12 3.6l2.6 5.3 5.8.85-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.85z';

export function StarIcon({ filled, size = 16 }: { filled: boolean; size?: number }) {
  return (
    <svg {...base} width={size} height={size} fill={filled ? 'currentColor' : 'none'}>
      <path d={STAR} />
    </svg>
  );
}

export function DownloadIcon({ size = 16 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M12 3.8v10.4" />
      <path d="M7.8 10.4 12 14.6l4.2-4.2" />
      <path d="M4.8 17.6v1.4a1.2 1.2 0 0 0 1.2 1.2h12a1.2 1.2 0 0 0 1.2-1.2v-1.4" />
    </svg>
  );
}

export function RenameIcon({ size = 16 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M16.4 3.9a1.9 1.9 0 0 1 2.7 2.7L8.7 17l-3.6 1 1-3.6z" />
      <path d="M14.6 5.7 17.3 8.4" />
    </svg>
  );
}

export function OpenIcon({ size = 16 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M4.6 6.4a1.8 1.8 0 0 1 1.8-1.8h4l2 2.2h5.2a1.8 1.8 0 0 1 1.8 1.8v7a1.8 1.8 0 0 1-1.8 1.8H6.4a1.8 1.8 0 0 1-1.8-1.8z" />
    </svg>
  );
}

export function ShareIcon({ size = 16 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      <circle cx="17.6" cy="5.8" r="2.6" />
      <circle cx="6.4" cy="12" r="2.6" />
      <circle cx="17.6" cy="18.2" r="2.6" />
      <path d="M8.8 10.7 15.2 7.1M8.8 13.3l6.4 3.6" />
    </svg>
  );
}
