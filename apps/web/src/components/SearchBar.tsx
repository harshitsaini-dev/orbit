import { useEffect, useState } from 'react';
import { FILE_CATEGORIES, CATEGORY_LABELS, type FileCategory } from '@orbit/shared-types';

export type SearchScope = 'folder' | 'account';

export interface SearchFilters {
  text: string;
  scope: SearchScope;
  categories: FileCategory[];
  /** Days back, or 0 for any time. */
  withinDays: number;
  /** One of the named size bands, or 'any'. */
  size: 'any' | 'small' | 'medium' | 'large';
  starredOnly: boolean;
  fullText: boolean;
}

export const EMPTY_FILTERS: SearchFilters = {
  text: '',
  scope: 'folder',
  categories: [],
  withinDays: 0,
  size: 'any',
  starredOnly: false,
  fullText: false,
};

/** Bands rather than a byte field: nobody wants to type 10485760. */
export const SIZE_BANDS: Record<SearchFilters['size'], { min?: number; max?: number; label: string }> = {
  any: { label: 'Any size' },
  small: { max: 1024 * 1024, label: 'Under 1 MB' },
  medium: { min: 1024 * 1024, max: 100 * 1024 * 1024, label: '1 MB – 100 MB' },
  large: { min: 100 * 1024 * 1024, label: 'Over 100 MB' },
};

const WITHIN_OPTIONS = [
  { days: 0, label: 'Any time' },
  { days: 1, label: 'Today' },
  { days: 7, label: 'Past week' },
  { days: 30, label: 'Past month' },
  { days: 365, label: 'Past year' },
];

export function hasCriteria(filters: SearchFilters): boolean {
  return (
    filters.text.trim() !== '' ||
    filters.categories.length > 0 ||
    filters.withinDays > 0 ||
    filters.size !== 'any' ||
    filters.starredOnly
  );
}

const controlStyle: React.CSSProperties = {
  border: 0,
  padding: '0.4rem 0.65rem',
  font: 'inherit',
  fontSize: 13,
  color: 'var(--text)',
  borderRadius: 'var(--radius-sm)',
};

/**
 * Search the way a file manager does: typing here looks inside subfolders, not
 * just at what happens to be loaded.
 */
export function SearchBar({
  filters,
  onChange,
  currentPath,
  searching,
  resultCount,
  fullTextSupported,
}: {
  filters: SearchFilters;
  onChange: (filters: SearchFilters) => void;
  currentPath: string;
  searching: boolean;
  resultCount: number | null;
  fullTextSupported: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const active = hasCriteria(filters);

  // Open the filter row on its own once a search is running, so the controls
  // that shape it are visible rather than hidden behind another click.
  useEffect(() => {
    if (active) setExpanded(true);
  }, [active]);

  function set(changes: Partial<SearchFilters>): void {
    onChange({ ...filters, ...changes });
  }

  function toggleCategory(category: FileCategory): void {
    set({
      categories: filters.categories.includes(category)
        ? filters.categories.filter((entry) => entry !== category)
        : [...filters.categories, category],
    });
  }

  const scopeLabel =
    filters.scope === 'folder'
      ? currentPath === '/'
        ? 'this drive'
        : `${currentPath} and below`
      : 'everywhere in this account';

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="search"
          value={filters.text}
          onChange={(event) => set({ text: event.target.value })}
          placeholder={`Search ${scopeLabel}`}
          aria-label="Search files"
          className="clay-sunken"
          style={{
            flex: '1 1 220px',
            minWidth: 0,
            border: 0,
            padding: '0.55rem 0.9rem',
            font: 'inherit',
            fontSize: 14,
            color: 'var(--text)',
            borderRadius: 'var(--radius-pill)',
          }}
        />

        <button
          type="button"
          className="clay-button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          style={{ padding: '0.45rem 1rem', fontSize: 13, color: active ? 'var(--accent)' : undefined }}
        >
          Filters{active ? ' ·' : ''}
        </button>

        {active && (
          <button
            type="button"
            className="clay-button"
            style={{ padding: '0.45rem 1rem', fontSize: 13 }}
            onClick={() => onChange({ ...EMPTY_FILTERS, scope: filters.scope })}
          >
            Clear
          </button>
        )}
      </div>

      {expanded && (
        <div className="clay-sunken" style={{ padding: '0.8rem 0.9rem', display: 'grid', gap: 10, borderRadius: 'var(--radius-md)' }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <span style={{ color: 'var(--text-muted)' }}>Look in</span>
              <select
                value={filters.scope}
                onChange={(event) => set({ scope: event.target.value as SearchScope })}
                aria-label="Search scope"
                className="clay"
                style={controlStyle}
              >
                <option value="folder">{currentPath === '/' ? 'This drive' : 'This folder and below'}</option>
                <option value="account">Everywhere in this account</option>
              </select>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <span style={{ color: 'var(--text-muted)' }}>Modified</span>
              <select
                value={filters.withinDays}
                onChange={(event) => set({ withinDays: Number(event.target.value) })}
                aria-label="Modified within"
                className="clay"
                style={controlStyle}
              >
                {WITHIN_OPTIONS.map((option) => (
                  <option key={option.days} value={option.days}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <span style={{ color: 'var(--text-muted)' }}>Size</span>
              <select
                value={filters.size}
                onChange={(event) => set({ size: event.target.value as SearchFilters['size'] })}
                aria-label="Size"
                className="clay"
                style={controlStyle}
              >
                {Object.entries(SIZE_BANDS).map(([key, band]) => (
                  <option key={key} value={key}>
                    {band.label}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={filters.starredOnly}
                onChange={(event) => set({ starredOnly: event.target.checked })}
                style={{ accentColor: 'var(--accent)' }}
              />
              Starred only
            </label>

            {fullTextSupported && (
              <label
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}
                title="Also match text inside documents, not just their names"
              >
                <input
                  type="checkbox"
                  checked={filters.fullText}
                  onChange={(event) => set({ fullText: event.target.checked })}
                  style={{ accentColor: 'var(--accent)' }}
                />
                Search file contents
              </label>
            )}
          </div>

          <div className="scroll-x" style={{ display: 'flex', gap: 6, paddingBottom: 2 }}>
            {FILE_CATEGORIES.map((category) => {
              const on = filters.categories.includes(category);
              return (
                <button
                  key={category}
                  type="button"
                  className="clay-button"
                  aria-pressed={on}
                  onClick={() => toggleCategory(category)}
                  style={{
                    padding: '0.3rem 0.85rem',
                    fontSize: 12,
                    whiteSpace: 'nowrap',
                    boxShadow: on ? 'var(--shadow-clay-inset)' : 'var(--shadow-clay)',
                    color: on ? 'var(--accent)' : undefined,
                  }}
                >
                  {CATEGORY_LABELS[category]}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {active && (
        <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }} role="status">
          {searching
            ? 'Searching…'
            : resultCount === null
              ? ''
              : `${resultCount} ${resultCount === 1 ? 'result' : 'results'} in ${scopeLabel}`}
        </p>
      )}
    </div>
  );
}
