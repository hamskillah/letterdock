import React, { createContext, useContext, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';

interface ThemeContextType {
  theme: Theme;
  resolvedTheme: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: 'system',
  resolvedTheme: 'light',
  setTheme: () => {},
  toggleTheme: () => {}
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem('letterdock_theme');
      if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
    } catch {}
    return 'system';
  });

  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const updateResolved = () => {
      const resolved = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
      setResolvedTheme(resolved);
      document.documentElement.setAttribute('data-theme', resolved);
    };

    updateResolved();
    media.addEventListener('change', updateResolved);
    try {
      localStorage.setItem('letterdock_theme', theme);
    } catch {}

    return () => media.removeEventListener('change', updateResolved);
  }, [theme]);

  const setTheme = (t: Theme) => setThemeState(t);
  const toggleTheme = () => {
    setThemeState(current => {
      if (current === 'light') return 'dark';
      if (current === 'dark') return 'system';
      return 'light';
    });
  };

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
