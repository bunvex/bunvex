// The landing page renders what content.ts says, with working links, working tabs and no accessibility
// violations (SITE-01 §6). The site is dark only.
import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { Landing } from "../src/components/landing.tsx";
import { BENCH, DEMO, EXAMPLES, FILES, HERO, INSTALL, NOTICE, SITE, STATUS } from "../src/content.ts";
import { expectAccessible } from "./axe.ts";

const renderLanding = () => {
  document.documentElement.classList.add("dark");
  return render(<Landing />);
};

describe("Landing", () => {
  test("the one h1 is the headline", () => {
    renderLanding();
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([HERO.headline.join(" ")]);
  });

  test("the primary call to action opens the examples; the secondary stars the repository", () => {
    renderLanding();
    const examples = screen.getAllByRole("link", { name: /try an example/i });
    expect(examples.length).toBe(2);
    for (const a of examples) expect(a.getAttribute("href")).toBe(EXAMPLES);
    for (const a of screen.getAllByRole("link", { name: /star on github/i }))
      expect(a.getAttribute("href")).toBe(SITE.repo);
  });

  test("the install box shows each command set in its own tab", () => {
    renderLanding();
    const tabs = within(screen.getByRole("tablist", { name: "Install" })).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(INSTALL.map((i) => i.label));
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(tabs[1]!);
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    const panel = document.getElementById(tabs[1]!.getAttribute("aria-controls")!)!;
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain(INSTALL[1].lines[0]);
  });

  test("tabs follow the arrow keys", () => {
    renderLanding();
    const tabs = within(screen.getByRole("tablist", { name: "Workload" })).getAllByRole("tab");
    fireEvent.keyDown(tabs[0]!, { key: "ArrowDown" });
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tabs[1]!, { key: "End" });
    expect(tabs.at(-1)!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tabs.at(-1)!, { key: "ArrowDown" });
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
  });

  test("the live demo starts from the seeded conversation, in both tabs", () => {
    renderLanding();
    const demo = screen.getByRole("figure", { name: /two browser tabs/i });
    for (const m of DEMO.seed) expect(within(demo).getAllByText(m.text).length).toBe(2);
  });

  test("every workload has a bar per series, and the out-of-memory run says so", () => {
    const { container } = renderLanding();
    const bars = [...container.querySelectorAll<HTMLElement>("#benchmarks [data-bar]")];
    expect(bars.length).toBe(BENCH.rows.length * 3);
    for (const bar of bars) expect(bar.style.width).toMatch(/^\d+(\.\d+)?%$/);
    const oom = BENCH.rows.findIndex((r) => r.convex.startsWith("OOM"));
    expect(bars[oom * 3]!.textContent).toBe("out of memory");
  });

  test("the benchmark keeps a table with every number, and links to the full report", () => {
    renderLanding();
    const table = screen.getByRole("table");
    for (const row of BENCH.rows)
      for (const cell of [row.metric, row.convex, row.postgres, row.sqlite])
        expect(within(table).getByText(cell)).toBeTruthy();
    expect(screen.getByRole("link", { name: /full report/i }).getAttribute("href")).toBe(BENCH.report);
    expect(screen.getByText(BENCH.reading, { exact: false })).toBeTruthy();
  });

  test("code blocks wrap rather than scroll, so no unfocusable scroll region exists at any width", () => {
    renderLanding();
    const blocks = [...document.querySelectorAll("pre")];
    expect(blocks.length).toBeGreaterThanOrEqual(FILES.files.length);
    for (const b of blocks) {
      expect(b.className).toContain("whitespace-pre-wrap");
      expect(b.className).not.toMatch(/overflow-(x-)?(auto|scroll)/);
    }
  });

  test("the roadmap lists every phase with its status and links to the parity tables", () => {
    renderLanding();
    const status = screen.getByRole("region", { name: /pre-alpha/i });
    for (const phase of STATUS.phases) {
      expect(within(status).getByText(phase.summary)).toBeTruthy();
      if (!phase.done) expect(within(status).getByText(phase.left)).toBeTruthy();
    }
    expect(screen.getByRole("link", { name: /parity tables/i }).getAttribute("href")).toBe(STATUS.parity);
  });

  test("Docs is announced as coming soon, not a link", () => {
    renderLanding();
    expect(screen.queryByRole("link", { name: /^docs/i })).toBeNull();
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

  test("no accessibility violations", async () => {
    renderLanding();
    await expectAccessible();
  });
});
