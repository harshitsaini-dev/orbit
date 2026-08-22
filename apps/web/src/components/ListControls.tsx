import { useCallback, useMemo, useState } from 'react';
import type { OrbitFile } from '@orbit/shared-types';
import { GridViewIcon, ListViewIcon } from './Icons.js';

/**
 * The controls every list of files gets.
 *
 * Extracted because they kept not being. My Drive grew a view switch, a filter
 * and thumbnails; Recent, Starred, Shared with me and Collections did not, and
 * nothing about them said they should not have. A page that shows files should
 * behave like the other pages that show files, and the way to make that true is
 * for it to be one component rather than four rememberings.
 *
 * Anything added here appears everywhere at once, which is the point.
 */

export type ListView = 'list' | 'grid';

/**
 * The chosen view, remembered per page.
 *
 * Per page rather than globally: how somebody wants to read a folder of photos
 * and how they want to read a list of collections are different questions, and
 * answering one should not answer the other.
 */
export function useListView(key: string): [ListView, (next: ListView) => void] {
  const storageKey = `orbit.view.${key}`;

  const [view, setView] = useState<ListView>(() =>
    localStorage.getItem(storageKey) === 'grid' ? 'grid' : 'list',
  );

  const choose = useCallback(
    (next: ListView) => {
      setView(next);
      localStorage.setItem(storageKey, next);
    },
    [storageKey],
  );

  return [view, choose];
}

/**
 * Filters a list of files by name and path.
 *
 * Both, because people look for a file by its name and for a folder's contents
 * by where they are - and which of the two they meant is not knowable from the
 * text they typed.
 */
export function useFileFilter<T extends Pick<OrbitFile, 'name' | 'virtualPath'>>(
  files: T[],
): { filter: string; setFilter: (value: string) => void; shown: T[] } {
  const [filter, setFilterState] = useState('');

  // Wrapped so callers can name it in a dependency array without the linter
  // taking it for a value that changes every render.
  const setFilter = useCallback((value: string) => setFilterState(value), []);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return files;

    return files.filter(
      (file) =>
        file.name.toLowerCase().includes(needle) ||
        file.virtualPath.toLowerCase().includes(needle),
    );
  }, [files, filter]);

  return { filter, setFilter, shown };
}

export type SortKey = 'name' | 'size' | 'modified';

const SORTS: Array<{ value: SortKey; label: string }> = [
  { value: 'name', label: 'Name' },
  { value: 'size', label: 'Size' },
  { value: 'modified', label: 'Modified' },
];

interface Sortable {
  name: string;
  sizeBytes: number;
  isFolder?: boolean;
  modifiedAt?: string;
}

/**
 * Sorting, remembered per page like the view is.
 *
 * Folders stay above files whichever key is chosen. Sorting a folder in among
 * the files by size - where it has none - reads as a bug, and nobody looking
 * for "the biggest thing here" means a folder.
 */
export function useFileSort<T extends Sortable>(
  key: string,
  files: T[],
): {
  sort: SortKey;
  setSort: (next: SortKey) => void;
  descending: boolean;
  toggleDirection: () => void;
  sorted: T[];
} {
  const storageKey = `orbit.sort.${key}`;
  const stored = localStorage.getItem(storageKey)?.split(':') ?? [];

  /*
   * Newest first, until somebody says otherwise.
   *
   * A file manager is opened to find what was touched recently far more often
   * than to find something alphabetically - and an alphabetical list of a real
   * drive puts "1-й семестр" and "200+ gb Asset pack" at the top, which is
   * nobody's idea of what matters.
   */
  const remembered = SORTS.some((option) => option.value === stored[0]);

  const [sort, setSortState] = useState<SortKey>(
    remembered ? (stored[0] as SortKey) : 'modified',
  );
  const [descending, setDescending] = useState(remembered ? stored[1] === 'desc' : true);

  const remember = useCallback(
    (next: SortKey, down: boolean) => {
      localStorage.setItem(storageKey, `${next}:${down ? 'desc' : 'asc'}`);
    },
    [storageKey],
  );

  const setSort = useCallback(
    (next: SortKey) => {
      setSortState(next);
      // Sizes and dates are almost always wanted largest and newest first;
      // names are not. Choosing a key sets the direction people meant by it,
      // and the arrow is there for when they meant the other one.
      const down = next !== 'name';
      setDescending(down);
      remember(next, down);
    },
    [remember],
  );

  const toggleDirection = useCallback(() => {
    setDescending((current) => {
      remember(sort, !current);
      return !current;
    });
  }, [remember, sort]);

  const sorted = useMemo(() => {
    const direction = descending ? -1 : 1;

    return [...files].sort((a, b) => {
      if (Boolean(a.isFolder) !== Boolean(b.isFolder)) return a.isFolder ? -1 : 1;

      if (sort === 'size') return (a.sizeBytes - b.sizeBytes) * direction;
      if (sort === 'modified') {
        return (
          (new Date(a.modifiedAt ?? 0).getTime() - new Date(b.modifiedAt ?? 0).getTime()) *
          direction
        );
      }

      // Numeric so "file 10" follows "file 9" rather than "file 1".
      return a.name.localeCompare(b.name, undefined, { numeric: true }) * direction;
    });
  }, [files, sort, descending]);

  return { sort, setSort, descending, toggleDirection, sorted };
}

export function SortControl({
  sort,
  onSort,
  descending,
  onToggleDirection,
}: {
  sort: SortKey;
  onSort: (next: SortKey) => void;
  descending: boolean;
  onToggleDirection: () => void;
}) {
  return (
    <span className="sort-control">
      <label>
        <span>Sort</span>
        <select
          className="clay-sunken"
          value={sort}
          onChange={(event) => onSort(event.target.value as SortKey)}
        >
          {SORTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        className="clay-button"
        aria-label={descending ? 'Sort ascending' : 'Sort descending'}
        title={descending ? 'Largest or newest first' : 'Smallest or oldest first'}
        onClick={onToggleDirection}
      >
        {descending ? '↓' : '↑'}
      </button>
    </span>
  );
}

export function ViewToggle({
  view,
  onChange,
}: {
  view: ListView;
  onChange: (next: ListView) => void;
}) {
  return (
    <div className="view-toggle" role="group" aria-label="How to show these files">
      <button
        type="button"
        aria-pressed={view === 'list'}
        title="One row each, with where it lives"
        onClick={() => onChange('list')}
      >
        <ListViewIcon size={16} />
        <span>List</span>
      </button>
      <button
        type="button"
        aria-pressed={view === 'grid'}
        title="Bigger pictures, for telling files apart by sight"
        onClick={() => onChange('grid')}
      >
        <GridViewIcon size={16} />
        <span>Grid</span>
      </button>
    </div>
  );
}

/**
 * The filter box.
 *
 * Shown wherever there is anything to filter, rather than only above a long
 * list. Hiding it under a threshold was the wrong call: somebody who has
 * learned that a page has a search box should find it there every time, and a
 * control that comes and goes with the number of rows reads as missing rather
 * than as unnecessary.
 */
export function FilterBox({
  value,
  onChange,
  count,
  noun = 'files',
}: {
  value: string;
  onChange: (value: string) => void;
  count: number;
  noun?: string;
}) {
  if (count === 0) return null;

  return (
    <input
      type="search"
      className="clay-sunken list-filter"
      placeholder={`Filter ${count.toLocaleString()} ${noun}…`}
      aria-label={`Filter these ${noun}`}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
