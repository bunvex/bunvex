import { ThemeToggle } from "@bunvex/ui/components/theme-toggle";
import { useSyncExternalStore } from "react";

const noop = () => () => {};

/**
 * The theme toggle, rendered only once hydrated. The prerendered HTML cannot know the visitor's stored
 * theme, so rendering the toggle on the server would make its icon and label differ from the client's first
 * render — a hydration mismatch that discards the whole page's server HTML. The placeholder keeps its size.
 */
export function ClientThemeToggle() {
  const hydrated = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  return hydrated ? <ThemeToggle /> : <span aria-hidden="true" className="inline-block size-8" />;
}
