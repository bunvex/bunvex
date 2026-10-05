// The landing page renders what content.ts says, with working links and no accessibility violations,
// in both themes (SITE-01 §6).
import { describe, expect, test } from "bun:test";
import { TooltipProvider } from "@bunvex/ui/components/tooltip";
import { ThemeProvider } from "@bunvex/ui/theme";
import { render, screen, within } from "@testing-library/react";
import { Landing } from "../src/components/landing.tsx";
import { BENCH, CODE, HERO, NOTICE, SITE, STATUS } from "../src/content.ts";
import { expectAccessible } from "./axe.ts";

const renderLanding = () =>
  render(
    <ThemeProvider>
      <TooltipProvider>
        <Landing />
      </TooltipProvider>
    </ThemeProvider>,
  );

describe("Landing", () => {
  test("the one h1 is the headline", () => {
    renderLanding();
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([HERO.headline]);
  });

  test("the primary call to action stars the repository on GitHub", () => {
    renderLanding();
    expect(screen.getByRole("link", { name: /star on github/i }).getAttribute("href")).toBe(SITE.repo);
    expect(screen.getByRole("link", { name: /see the benchmarks/i }).getAttribute("href")).toBe("#benchmarks");
  });

  test("the benchmark is a table with every number, and links to the full report", () => {
    renderLanding();
    const table = screen.getByRole("table");
    for (const row of BENCH.rows)
      for (const cell of [row.metric, row.convex, row.postgres, row.sqlite])
        expect(within(table).getByText(cell)).toBeTruthy();
    expect(screen.getByRole("link", { name: /full report/i }).getAttribute("href")).toBe(BENCH.report);
  });

  test("every benchmark bar has a width, the shortest for a cell with no number (an out-of-memory run)", () => {
    const { container } = renderLanding();
    const bars = [...container.querySelectorAll<HTMLElement>("#benchmarks td span[style]")];
    expect(bars.length).toBe(BENCH.rows.length * 3);
    for (const bar of bars) expect(bar.style.width).toMatch(/^\d+(\.\d+)?%$/);
    const oom = BENCH.rows.findIndex((r) => r.convex.startsWith("OOM"));
    expect(oom).toBeGreaterThan(-1);
    expect(bars[oom * 3]!.style.width).toBe("2%");
  });

  test("code blocks wrap rather than scroll, so no unfocusable scroll region exists at any width", () => {
    renderLanding();
    const blocks = [...document.querySelectorAll("pre")];
    expect(blocks.length).toBe(CODE.files.length);
    for (const b of blocks) {
      expect(b.className).toContain("whitespace-pre-wrap");
      expect(b.className).not.toMatch(/overflow-(x-)?(auto|scroll)/);
    }
  });

  test("the benchmark says which direction is better for each measure", () => {
    renderLanding();
    expect(screen.getByText(BENCH.reading)).toBeTruthy();
    expect(BENCH.reading).toMatch(/lower p99/i);
  });

  test("the code sample says it is the target API", () => {
    renderLanding();
    expect(screen.getByText(CODE.label)).toBeTruthy();
  });

  test("the roadmap lists every phase and links to the parity tables", () => {
    renderLanding();
    for (const phase of STATUS.phases) expect(screen.getByText(phase.summary)).toBeTruthy();
    expect(screen.getByRole("link", { name: /parity/i }).getAttribute("href")).toBe(STATUS.parity);
  });

  test("Docs is announced as coming soon, not a link", () => {
    renderLanding();
    expect(screen.queryByRole("link", { name: /docs/i })).toBeNull();
    expect(screen.getByText("Docs").closest("[aria-disabled=true]")).toBeTruthy();
  });

  test("the footer carries the not-affiliated notice", () => {
    renderLanding();
    expect(within(screen.getByRole("contentinfo")).getByText(NOTICE)).toBeTruthy();
  });

  test("every section is a landmark named by its heading", () => {
    renderLanding();
    const titles = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(titles.length).toBeGreaterThan(0);
    expect(
      screen
        .getAllByRole("region")
        .map(
          (r) =>
            r.getAttribute("aria-labelledby") &&
            document.getElementById(r.getAttribute("aria-labelledby")!)?.textContent,
        ),
    ).toEqual(titles);
  });

  test("no accessibility violations, light and dark", async () => {
    renderLanding();
    await expectAccessible();
    document.documentElement.classList.add("dark");
    await expectAccessible();
  });
});
