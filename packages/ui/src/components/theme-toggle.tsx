import { Button } from "@bunvex/ui/components/button";
import { type Theme, useTheme } from "@bunvex/ui/theme";
import { Monitor, Moon, Sun } from "lucide-react";

const NEXT: Record<Theme, Theme> = { light: "dark", dark: "system", system: "light" };
const LABEL: Record<Theme, string> = { light: "Light theme", dark: "Dark theme", system: "System theme" };
const ICON = { light: Sun, dark: Moon, system: Monitor } as const;

/** Cycles light → dark → system. The accessible name says the current theme and what a press does. */
function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const Icon = ICON[theme];
  const label = `${LABEL[theme]} (switch to ${LABEL[NEXT[theme]].toLowerCase()})`;
  // a native title, not a Tooltip: the toggle sits in every page's header, and Base UI's tooltip brings the
  // whole floating-positioning engine into the dashboard's first load (~83 kB, UI-01 §14.1)
  return (
    <Button variant="ghost" size="icon" aria-label={label} title={LABEL[theme]} onClick={() => setTheme(NEXT[theme])}>
      <Icon aria-hidden="true" />
    </Button>
  );
}

export { ThemeToggle };
