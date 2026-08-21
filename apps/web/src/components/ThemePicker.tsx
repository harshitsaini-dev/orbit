import type { ThemeMode } from '@orbit/shared-types';
import { ACCENTS, useTheme } from '../lib/theme.js';

/**
 * Theme and accent for the pages outside the workspace.
 *
 * Signed in, appearance is saved to the account and lives in the account menu.
 * Here there is no account yet, so it stays local — but a visitor arriving on a
 * bright page at night should still be able to turn it down.
 */
export function ThemePicker({ compact = false }: { compact?: boolean }) {
  const { theme, accent, setTheme, setAccent } = useTheme();

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span className="clay-sunken" style={{ display: 'flex', gap: 3, padding: 3, borderRadius: 'var(--radius-pill)' }}>
        {(['light', 'system', 'dark'] as ThemeMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            className="clay-button"
            aria-pressed={theme === mode}
            aria-label={`${mode} theme`}
            title={`${mode} theme`}
            onClick={() => setTheme(mode)}
            style={{
              padding: '0.3rem 0.55rem',
              display: 'grid',
              placeItems: 'center',
              boxShadow: theme === mode ? 'var(--shadow-clay)' : 'none',
              background: theme === mode ? 'var(--surface)' : 'transparent',
              color: theme === mode ? 'var(--accent)' : 'var(--text-muted)',
            }}
          >
            {mode === 'light' ? <SunGlyph /> : mode === 'dark' ? <MoonGlyph /> : <AutoGlyph />}
          </button>
        ))}
      </span>

      {!compact && (
        <span style={{ display: 'flex', gap: 5 }}>
          {ACCENTS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-label={`Accent ${option.name}`}
              aria-pressed={accent === option.value}
              title={option.name}
              onClick={() => setAccent(option.value)}
              style={{
                width: 20,
                height: 20,
                padding: 0,
                borderRadius: '50%',
                border: accent === option.value ? '2px solid var(--text)' : '2px solid transparent',
                background: option.value,
                cursor: 'pointer',
              }}
            />
          ))}
        </span>
      )}
    </span>
  );
}

const glyph = {
  viewBox: '0 0 24 24',
  width: 15,
  height: 15,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  style: { display: 'block' },
} as const;

const SunGlyph = () => (
  <svg {...glyph}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.8v2.2M12 19v2.2M4.5 4.5l1.6 1.6M17.9 17.9l1.6 1.6M2.8 12H5M19 12h2.2M4.5 19.5l1.6-1.6M17.9 6.1l1.6-1.6" />
  </svg>
);

const MoonGlyph = () => (
  <svg {...glyph}>
    <path d="M20 14.2A8.4 8.4 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2z" />
  </svg>
);

const AutoGlyph = () => (
  <svg {...glyph}>
    <circle cx="12" cy="12" r="8.4" />
    <path d="M12 3.6v16.8" />
    <path d="M12 3.6a8.4 8.4 0 0 1 0 16.8z" fill="currentColor" stroke="none" />
  </svg>
);
