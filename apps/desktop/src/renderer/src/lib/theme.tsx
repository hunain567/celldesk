import type { Theme } from '@celldesk/shared';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { call } from './api';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => Promise<void>;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function apply(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && darkQuery.matches);
  document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
}

/** Loads the saved theme, applies it, and follows Windows when set to "system". */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('system');

  useEffect(() => {
    void call('settings:get', { key: 'ui.theme' })
      .then((value) => {
        const saved = value === 'light' || value === 'dark' ? value : 'system';
        setThemeState(saved);
      })
      .catch(() => setThemeState('system'));
  }, []);

  useEffect(() => {
    apply(theme);
    if (theme !== 'system') return undefined;
    const listener = () => apply('system');
    darkQuery.addEventListener('change', listener);
    return () => darkQuery.removeEventListener('change', listener);
  }, [theme]);

  const setTheme = useCallback(async (next: Theme) => {
    setThemeState(next);
    await call('settings:set', { key: 'ui.theme', value: next });
  }, []);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
