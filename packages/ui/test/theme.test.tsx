import { describe, expect, mock, test } from "bun:test";
import { ThemeToggle } from "@bunvex/ui/components/theme-toggle";
import { TooltipProvider } from "@bunvex/ui/components/tooltip";
import { THEME_STORAGE_KEY, ThemeProvider, themeScript, useTheme } from "@bunvex/ui/theme";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { expectAccessible } from "./axe.ts";

/** A controllable prefers-color-scheme. */
function fakeSystem(dark: boolean) {
  const listeners = new Set<() => void>();
  const mq = {
    get matches() {
      return dark;
    },
    addEventListener: (_: string, f: () => void) => listeners.add(f),
    removeEventListener: (_: string, f: () => void) => listeners.delete(f),
  };
  window.matchMedia = mock(() => mq) as unknown as typeof window.matchMedia;
  return {
    set(next: boolean) {
      dark = next;
      for (const f of listeners) f();
    },
  };
}

const wrapper = ({ children }: { children: ReactNode }) => <ThemeProvider>{children}</ThemeProvider>;
const isDark = () => document.documentElement.classList.contains("dark");

describe("ThemeProvider", () => {
  test("system mode follows prefers-color-scheme, live", () => {
    const system = fakeSystem(false);
    const { result } = renderHook(useTheme, { wrapper });
    expect(result.current.theme).toBe("system");
    expect(isDark()).toBe(false);
    act(() => system.set(true));
    expect(result.current.resolvedTheme).toBe("dark");
    expect(isDark()).toBe(true);
  });

  test("an explicit choice wins over the system and is persisted", () => {
    fakeSystem(true);
    const { result } = renderHook(useTheme, { wrapper });
    act(() => result.current.setTheme("light"));
    expect(isDark()).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  test("the stored choice is read on mount; garbage is ignored", () => {
    fakeSystem(false);
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    expect(renderHook(useTheme, { wrapper }).result.current.theme).toBe("dark");
    localStorage.setItem(THEME_STORAGE_KEY, "purple");
    expect(renderHook(useTheme, { wrapper }).result.current.theme).toBe("system");
  });

  test("useTheme outside the provider throws", () => {
    expect(() => renderHook(useTheme)).toThrow("inside <ThemeProvider>");
  });

  test("themeScript applies the stored theme before React", () => {
    fakeSystem(false);
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    new Function(themeScript())();
    expect(isDark()).toBe(true);
  });
});

describe("ThemeToggle", () => {
  test("cycles light → dark → system with an accessible name that says so", async () => {
    fakeSystem(false);
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    render(
      <ThemeProvider>
        <TooltipProvider>
          <ThemeToggle />
        </TooltipProvider>
      </ThemeProvider>,
    );
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: /^Light theme \(switch to dark theme\)$/ });
    await expectAccessible();
    await user.click(button);
    expect(isDark()).toBe(true);
    expect(screen.getByRole("button", { name: /^Dark theme/ })).toBeDefined();
    await user.click(screen.getByRole("button", { name: /^Dark theme/ }));
    expect(screen.getByRole("button", { name: /^System theme/ })).toBeDefined();
    expect(isDark()).toBe(false);
  });
});
