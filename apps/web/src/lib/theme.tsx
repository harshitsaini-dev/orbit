import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ThemeMode } from '@orbit/shared-types';

const STORAGE_KEY = 'orbit:theme';
const ACCENT_KEY = 'orbit:accent';

export const ACCENTS = [
  { name: 'Nebula', value: '#6c8cff' },
  { name: 'Aurora', value: '#2fa87a' },
  { name: 'Solar', value: '#e08a2e' },
  { name: 'Nova', value: '#d95c8a' },
  { name: 'Comet', value: '#8b6cf5' },
] as const;

interface ThemeContextValue {
  theme: ThemeMode;
  accent: string;
  setTheme: (theme: ThemeMode) => void;
  setAccent: (accent: string) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function read<T extends string>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  return (window.localStorage.getItem(key) as T | null) ?? fallback;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(() => read<ThemeMode>(STORAGE_KEY, 'system'));
  const [accent, setAccentState] = useState<string>(() => read(ACCENT_KEY, ACCENTS[0].value));

  useEffect(() => {
    const root = document.documentElement;
    // 'system' means no attribute at all, so prefers-color-scheme decides.
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    window.localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty('--accent', accent);
    window.localStorage.setItem(ACCENT_KEY, accent);
  }, [accent]);

  const setTheme = useCallback((next: ThemeMode) => setThemeState(next), []);
  const setAccent = useCallback((next: string) => setAccentState(next), []);

  const value = useMemo(
    () => ({ theme, accent, setTheme, setAccent }),
    [theme, accent, setTheme, setAccent],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}
