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
 * Appears only once there is enough to need it. A search box above four files
 * is furniture, and it invites people to type into it rather than just read.
 */
export function FilterBox({
  value,
  onChange,
  count,
  noun = 'files',
  minimum = 8,
}: {
  value: string;
  onChange: (value: string) => void;
  count: number;
  noun?: string;
  minimum?: number;
}) {
  if (count < minimum) return null;

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
