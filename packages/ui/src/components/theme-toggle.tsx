import { Button } from "@bunvex/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bunvex/ui/components/tooltip";
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
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant="ghost" size="icon" aria-label={label} onClick={() => setTheme(NEXT[theme])} />}
      >
        <Icon aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent>{LABEL[theme]}</TooltipContent>
    </Tooltip>
  );
}

export { ThemeToggle };
