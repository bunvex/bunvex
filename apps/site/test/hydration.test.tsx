// The prerendered HTML must hydrate without a mismatch for a returning visitor whose theme choice is in
// localStorage — the prerender cannot know it (review finding, SITE-01 §6).
import { expect, test } from "bun:test";
import { TooltipProvider } from "@bunvex/ui/components/tooltip";
import { THEME_STORAGE_KEY, ThemeProvider } from "@bunvex/ui/theme";
import { act } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { Landing } from "../src/components/landing.tsx";

const page = () => (
  <ThemeProvider>
    <TooltipProvider>
      <Landing />
    </TooltipProvider>
  </ThemeProvider>
);

test.each(["dark", "light"])("hydrates without a mismatch when the stored theme is %s", async (stored) => {
  const container = document.createElement("div");
  container.innerHTML = renderToString(page()); // the prerender: nothing stored
  document.body.append(container);
  localStorage.setItem(THEME_STORAGE_KEY, stored);
  const errors: unknown[] = [];
  const root = await act(async () => hydrateRoot(container, page(), { onRecoverableError: (e) => errors.push(e) }));
  expect(errors).toEqual([]);
  act(() => root.unmount());
  container.remove();
});
