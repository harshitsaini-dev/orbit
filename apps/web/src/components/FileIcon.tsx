import { CATEGORY_COLOURS, categorise } from '@orbit/shared-types';

const FOLDER = 'M3.2 6.6c0-1 .8-1.8 1.8-1.8h3.6l2 2.2h8.4c1 0 1.8.8 1.8 1.8v8.6c0 1-.8 1.8-1.8 1.8H5c-1 0-1.8-.8-1.8-1.8z';

/** One glyph per file, coloured by the same palette the storage bar uses. */
export function FileIcon({
  name,
  mimeType,
  isFolder,
  size = 22,
}: {
  name: string;
  mimeType: string;
  isFolder: boolean;
  size?: number;
}) {
  if (isFolder) {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
        <path d={FOLDER} fill="var(--accent)" opacity="0.9" />
      </svg>
    );
  }

  const category = categorise(mimeType, name);
  const colour = CATEGORY_COLOURS[category];

  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      {/* A page with a folded corner, tinted by category. */}
      <path d="M6 3.4h7.2L19 9.2v11.4c0 .6-.5 1-1 1H6c-.6 0-1-.4-1-1V4.4c0-.6.4-1 1-1z" fill={colour} opacity="0.22" />
      <path d="M13.2 3.4 19 9.2h-4.8a1 1 0 0 1-1-1z" fill={colour} opacity="0.55" />
      <rect x="7.6" y="12.4" width="8.8" height="1.5" rx="0.75" fill={colour} opacity="0.8" />
      <rect x="7.6" y="15.6" width="6.2" height="1.5" rx="0.75" fill={colour} opacity="0.6" />
    </svg>
  );
}
