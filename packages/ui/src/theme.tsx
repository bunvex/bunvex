// Light / dark / system theming (UI-01 §4.1): the resolved theme is a `dark` class on <html>, the choice
// is kept in localStorage, and `system` follows prefers-color-scheme live.

import { DARK_QUERY, THEME_STORAGE_KEY, type Theme } from "@bunvex/ui/theme-script";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

export { THEME_STORAGE_KEY, type Theme, themeScript } from "@bunvex/ui/theme-script";
export type ResolvedTheme = "light" | "dark";

type ThemeContextValue = { theme: Theme; resolvedTheme: ResolvedTheme; setTheme: (theme: Theme) => void };
const ThemeContext = createContext<ThemeContextValue | null>(null);

const isTheme = (v: unknown): v is Theme => v === "light" || v === "dark" || v === "system";

function readStored(key: string): Theme | null {
  try {
    const v = localStorage.getItem(key);
    return isTheme(v) ? v : null;
  } catch {
    return null; // storage can be blocked (private mode, sandboxed iframes)
  }
}

const systemPrefersDark = () => typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches;

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = THEME_STORAGE_KEY,
}: {
  children: ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
}) {
  const [theme, setThemeState] = useState<Theme>(() => readStored(storageKey) ?? defaultTheme);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(DARK_QUERY);
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme: ResolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
  }, [resolvedTheme]);

  const setTheme = useCallback(
    (next: Theme) => {
      setThemeState(next);
      try {
        localStorage.setItem(storageKey, next);
      } catch {
        // the choice then lasts for this page only
      }
    },
    [storageKey],
  );

  const value = useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
