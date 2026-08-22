import type { SVGProps } from 'react';

/**
 * The line icons used in the navigation and toolbars.
 *
 * One stroke weight and one corner treatment across the set, so they read as a
 * family rather than as a pile of found glyphs.
 */
const base: SVGProps<SVGSVGElement> = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: 'false',
  style: { display: 'block', flexShrink: 0 },
};

type IconProps = { size?: number };

const Icon = ({ size = 18, children }: IconProps & { children: React.ReactNode }) => (
  <svg {...base} width={size} height={size}>
    {children}
  </svg>
);

export const DashboardIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <rect x="3.2" y="3.2" width="7.4" height="8.8" rx="2" />
    <rect x="13.4" y="3.2" width="7.4" height="5.4" rx="2" />
    <rect x="3.2" y="15" width="7.4" height="5.8" rx="2" />
    <rect x="13.4" y="11.6" width="7.4" height="9.2" rx="2" />
  </Icon>
);

export const DriveIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M3.4 7.2a2 2 0 0 1 2-2h3.3l2 2.3h7.9a2 2 0 0 1 2 2v8.3a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2z" />
  </Icon>
);

export const ClockIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 7.2V12l3.2 1.9" />
  </Icon>
);

export const StarOutlineIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M12 3.8l2.55 5.2 5.7.83-4.13 4 .98 5.7L12 16.85 6.9 19.53l.98-5.7-4.13-4 5.7-.83z" />
  </Icon>
);

export const SharedIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <circle cx="9" cy="8.4" r="3.2" />
    <path d="M3.6 19.4a5.6 5.6 0 0 1 10.8 0" />
    <circle cx="17.4" cy="7.4" r="2.4" />
    <path d="M16 13.2a4.6 4.6 0 0 1 4.4 4.5" />
  </Icon>
);

export const QuotaIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M3.6 15.4a8.4 8.4 0 1 1 16.8 0" />
    <path d="M12 15.4l4-4.4" />
    <circle cx="12" cy="15.6" r="1.5" />
  </Icon>
);

export const CodeIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M8.6 8.4 4.6 12l4 3.6" />
    <path d="M15.4 8.4 19.4 12l-4 3.6" />
    <path d="M13.4 5.6 10.6 18.4" />
  </Icon>
);

export const PersonIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <circle cx="12" cy="8.2" r="3.6" />
    <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
  </Icon>
);

export const UploadFileIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M13.4 3.4H7a1.8 1.8 0 0 0-1.8 1.8v13.6A1.8 1.8 0 0 0 7 20.6h10a1.8 1.8 0 0 0 1.8-1.8V8.8z" />
    <path d="M13.4 3.4v4.2a1.2 1.2 0 0 0 1.2 1.2h4.2" />
    <path d="M12 16.6v-5" />
    <path d="M9.8 13.4 12 11.2l2.2 2.2" />
  </Icon>
);

export const UploadFolderIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M3.4 7.4a1.8 1.8 0 0 1 1.8-1.8h3.2l2 2.2h7.4a1.8 1.8 0 0 1 1.8 1.8v8a1.8 1.8 0 0 1-1.8 1.8H5.2a1.8 1.8 0 0 1-1.8-1.8z" />
    <path d="M12 17v-5" />
    <path d="M9.8 14.2 12 12l2.2 2.2" />
  </Icon>
);

export const NewFolderIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M3.4 7.4a1.8 1.8 0 0 1 1.8-1.8h3.2l2 2.2h7.4a1.8 1.8 0 0 1 1.8 1.8v8a1.8 1.8 0 0 1-1.8 1.8H5.2a1.8 1.8 0 0 1-1.8-1.8z" />
    <path d="M12 11.4v4.4" />
    <path d="M9.8 13.6h4.4" />
  </Icon>
);

export const RefreshIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M20 12a8 8 0 1 1-2.6-5.9" />
    <path d="M20.2 4.6v4.2H16" />
  </Icon>
);

export const UpIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M12 19V6.4" />
    <path d="M6.6 11.8 12 6.4l5.4 5.4" />
  </Icon>
);

export const TrashIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M4.6 6.6h14.8" />
    <path d="M9.4 6.6V5a1.4 1.4 0 0 1 1.4-1.4h2.4A1.4 1.4 0 0 1 14.6 5v1.6" />
    <path d="M6.6 6.6l.9 12.2a1.6 1.6 0 0 0 1.6 1.5h5.8a1.6 1.6 0 0 0 1.6-1.5l.9-12.2" />
  </Icon>
);

export function CollectionsIcon({ size = 18 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      {/* Stacked cards: a grouping of things that live elsewhere. */}
      <rect x="4.4" y="8.6" width="15.2" height="11" rx="2.2" />
      <path d="M6.8 5.8h10.4M8.6 3h6.8" />
    </svg>
  );
}

export function DuplicatesIcon({ size = 18 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      {/* Two overlapping sheets: the same thing, twice. */}
      <rect x="8.6" y="8.6" width="11" height="11" rx="2.2" />
      <path d="M15.4 5.4H6.6a2.2 2.2 0 0 0-2.2 2.2v8.8" />
    </svg>
  );
}

export const SchedulesIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    {/* A clock with an arrow round it: something that happens again, rather
        than something that happened once. */}
    <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
    <path d="M20.6 3.4v4.2h-4.2" />
    <path d="M12 7.6V12l2.9 1.8" />
  </Icon>
);

export const FolderIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M3.4 7.2a2 2 0 0 1 2-2h3.3l2 2.3h7.9a2 2 0 0 1 2 2v8.3a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2z" />
  </Icon>
);

export const CopyIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    {/* One sheet behind another: the original stays where it was. */}
    <rect x="8.6" y="8.6" width="11.4" height="11.4" rx="2.2" />
    <path d="M15.4 5.4H6.2a2 2 0 0 0-2 2v9.2" />
  </Icon>
);

export const MoveIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    {/* Into a folder, rather than beside it. */}
    <path d="M3.4 7.2a2 2 0 0 1 2-2h3.3l2 2.3h7.9a2 2 0 0 1 2 2v8.3a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2z" />
    <path d="M12 9.4v6M9.4 12.8L12 15.4l2.6-2.6" />
  </Icon>
);

export const ListViewIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M8.4 6.6h11.2M8.4 12h11.2M8.4 17.4h11.2" />
    <path d="M4.4 6.6h.01M4.4 12h.01M4.4 17.4h.01" />
  </Icon>
);

export const GridViewIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <rect x="4.2" y="4.2" width="6.4" height="6.4" rx="1.6" />
    <rect x="13.4" y="4.2" width="6.4" height="6.4" rx="1.6" />
    <rect x="4.2" y="13.4" width="6.4" height="6.4" rx="1.6" />
    <rect x="13.4" y="13.4" width="6.4" height="6.4" rx="1.6" />
  </Icon>
);
