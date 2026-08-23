import { useEffect, useState } from 'react';
import { FILE_CATEGORIES, CATEGORY_LABELS, type FileCategory } from '@orbit/shared-types';
import { Checkbox } from './Checkbox.js';
import { Select } from './Select.js';

export type SearchScope = 'folder' | 'account';

export interface SearchFilters {
  text: string;
  scope: SearchScope;
  categories: FileCategory[];
  /** When it last changed. */
  modified: AgeKey;
  /**
   * When it was made, where the drive records that.
   *
   * Not every provider does - an S3 object has a last-modified and nothing
   * else - so this filter names the drives that cannot answer rather than
   * quietly returning nothing from them.
   */
  created: AgeKey;
  /** One of the named size bands, or 'any'. */
  size: 'any' | 'small' | 'medium' | 'large';
  starredOnly: boolean;
  fullText: boolean;
}

export const EMPTY_FILTERS: SearchFilters = {
  text: '',
  scope: 'folder',
  categories: [],
  modified: 'any',
  created: 'any',
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

/**
 * Both directions, because they answer different questions.
 *
 * "Changed in the past week" is what somebody asks when looking for what they
 * were working on. "Older than a year" is what they ask before clearing space,
 * and it is not the first question backwards - there was no way to ask it at
 * all, so the only way to find old files was to sort by date and scroll.
 */
export type AgeKey =
  | 'any'
  | 'day'
  | 'week'
  | 'month'
  | 'quarter'
  | 'year'
  | 'older-quarter'
  | 'older-half'
  | 'older-year'
  | 'older-two-years';

const DAY = 86_400_000;

export const AGE_BANDS: Record<AgeKey, { label: string; withinDays?: number; olderThanDays?: number }> = {
  any: { label: 'Any time' },
  day: { label: 'Past 24 hours', withinDays: 1 },
  week: { label: 'Past week', withinDays: 7 },
  month: { label: 'Past month', withinDays: 30 },
  quarter: { label: 'Past 3 months', withinDays: 90 },
  year: { label: 'Past year', withinDays: 365 },
  'older-quarter': { label: 'Older than 3 months', olderThanDays: 90 },
  'older-half': { label: 'Older than 6 months', olderThanDays: 182 },
  'older-year': { label: 'Older than a year', olderThanDays: 365 },
  'older-two-years': { label: 'Older than 2 years', olderThanDays: 730 },
};

/** The two ISO bounds a band means, for the query string. */
export function boundsFor(key: AgeKey): { after?: string; before?: string } {
  const band = AGE_BANDS[key];

  if (band.withinDays) {
    return { after: new Date(Date.now() - band.withinDays * DAY).toISOString() };
  }
  if (band.olderThanDays) {
    return { before: new Date(Date.now() - band.olderThanDays * DAY).toISOString() };
  }

  return {};
}

const AGE_OPTIONS = (Object.keys(AGE_BANDS) as AgeKey[]).map((key) => ({
  value: key,
  label: AGE_BANDS[key].label,
}));

export function hasCriteria(filters: SearchFilters): boolean {
  return (
    filters.text.trim() !== '' ||
    filters.categories.length > 0 ||
    filters.modified !== 'any' ||
    filters.created !== 'any' ||
    filters.size !== 'any' ||
    filters.starredOnly
  );
}

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
  createdSupported,
}: {
  filters: SearchFilters;
  onChange: (filters: SearchFilters) => void;
  currentPath: string;
  searching: boolean;
  resultCount: number | null;
  fullTextSupported: boolean;
  /**
   * Whether this drive records a created date at all.
   *
   * Most do not - Dropbox records when a client last wrote the file, an S3
   * object has a last-modified and nothing else. A filter that is there and
   * returns nothing is worse than one that is not there: it looks like an
   * answer about the files rather than about the drive.
   */
  createdSupported: boolean;
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
            <Field label="Look in">
              <Select
                label="Search scope"
                value={filters.scope}
                onChange={(scope) => set({ scope })}
                minWidth={180}
                options={[
                  { value: 'folder', label: currentPath === '/' ? 'This drive' : 'This folder and below' },
                  { value: 'account', label: 'Everywhere in this account' },
                ]}
              />
            </Field>

            <Field label="Modified">
              <Select
                label="Modified"
                value={filters.modified}
                onChange={(modified) => set({ modified })}
                minWidth={175}
                options={AGE_OPTIONS}
              />
            </Field>

            {createdSupported && (
              <Field label="Created">
                <Select
                  label="Created"
                  value={filters.created}
                  onChange={(created) => set({ created })}
                  minWidth={175}
                  options={AGE_OPTIONS}
                />
              </Field>
            )}

            <Field label="Size">
              <Select
                label="Size"
                value={filters.size}
                onChange={(size) => set({ size })}
                minWidth={150}
                options={Object.entries(SIZE_BANDS).map(([key, band]) => ({
                  value: key as SearchFilters['size'],
                  label: band.label,
                }))}
              />
            </Field>

            <Checkbox
              checked={filters.starredOnly}
              onChange={(starredOnly) => set({ starredOnly })}
              label="Starred only"
            />

            {fullTextSupported && (
              <span title="Also match text inside documents, not just their names">
                <Checkbox
                  checked={filters.fullText}
                  onChange={(fullText) => set({ fullText })}
                  label="Search file contents"
                />
              </span>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      {children}
    </span>
  );
}
