// The part of theming a host needs before React: the storage key, and a script that applies the stored
// theme before first paint (no flash of the wrong theme). No React import, so a build config can use it.

export type Theme = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "bunvex-theme";
export const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Inline this in <head> (before the stylesheet) to apply the stored theme before React mounts. */
export const themeScript = (storageKey = THEME_STORAGE_KEY, defaultTheme: Theme = "system") =>
  `(function(){try{var t=localStorage.getItem(${JSON.stringify(storageKey)})||${JSON.stringify(defaultTheme)};` +
  `if(t==="dark"||(t==="system"&&matchMedia(${JSON.stringify(DARK_QUERY)}).matches))` +
  `document.documentElement.classList.add("dark")}catch(e){}})()`;
