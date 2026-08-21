import { useCallback, useState } from 'react';

export type ViewMode = 'list' | 'grid';

const STORAGE_KEY = 'orbit:view-mode';

/**
 * Remembered locally rather than on the profile: which layout suits depends on
 * the screen in front of you, so it should not follow the account to a phone.
 */
export function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(() => {
    if (typeof window === 'undefined') return 'list';
    return window.localStorage.getItem(STORAGE_KEY) === 'grid' ? 'grid' : 'list';
  });

  const set = useCallback((next: ViewMode) => {
    setMode(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  }, []);

  return [mode, set];
}

export function ViewToggle({ value, onChange }: { value: ViewMode; onChange: (mode: ViewMode) => void }) {
  return (
    <div className="clay-sunken view-toggle" role="group" aria-label="View">
      <button
        type="button"
        className="clay-button"
        aria-pressed={value === 'list'}
        aria-label="List view"
        title="List view"
        onClick={() => onChange('list')}
      >
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
          <g fill="currentColor">
            <rect x="2.5" y="4" width="3" height="2.2" rx="0.8" />
            <rect x="7.5" y="4" width="10" height="2.2" rx="1.1" />
            <rect x="2.5" y="8.9" width="3" height="2.2" rx="0.8" />
            <rect x="7.5" y="8.9" width="10" height="2.2" rx="1.1" />
            <rect x="2.5" y="13.8" width="3" height="2.2" rx="0.8" />
            <rect x="7.5" y="13.8" width="10" height="2.2" rx="1.1" />
          </g>
        </svg>
      </button>

      <button
        type="button"
        className="clay-button"
        aria-pressed={value === 'grid'}
        aria-label="Grid view"
        title="Grid view"
        onClick={() => onChange('grid')}
      >
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
          <g fill="currentColor">
            <rect x="2.6" y="2.6" width="6.4" height="6.4" rx="1.6" />
            <rect x="11" y="2.6" width="6.4" height="6.4" rx="1.6" />
            <rect x="2.6" y="11" width="6.4" height="6.4" rx="1.6" />
            <rect x="11" y="11" width="6.4" height="6.4" rx="1.6" />
          </g>
        </svg>
      </button>
    </div>
  );
}
