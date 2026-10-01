// The UX review's layout and list fixes (UI-01 §20.3).
import { describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";

const NOW = Date.UTC(2026, 8, 29, 12);
function mount(path: string) {
  const source = new MockDataSource({ seed: 5, now: NOW, documents: { users: 6 }, liveWritesMs: 0 });
  render(<Dashboard dataSource={source} history={createMemoryHistory({ initialEntries: [path] })} />);
  return source;
}

describe("layout and lists after the UX review", () => {
  test("UX-4: the header has a one-line deployment summary for phones, labelled for assistive tech", async () => {
    mount("/");
    const banner = await screen.findByRole("banner");
    await within(banner).findAllByText("memory");
    const line = banner.querySelector("p.md\\:hidden");
    expect(line?.textContent).toMatch(/Deployment\s*local\s*·\s*Persistence\s*memory\s*·\s*Version/);
    expect(within(banner).getByRole("button", { name: "Run functions" })).toBeDefined();
  });

  test("UX-14: History says its count next to the title, not in a footer", async () => {
    mount("/history");
    const h1 = await screen.findByRole("heading", { level: 1, name: "History" });
    const count = await within(h1.parentElement!).findByText(/^\d+\+? events?$/);
    expect(count).toBeDefined();
    expect(screen.queryByText(/ loaded$/)).toBeNull();
  });

  test("UX-14 / UX-16: Files keeps its count by the title, no footer count; Open is as tall as its input", async () => {
    mount("/files");
    await screen.findByRole("heading", { level: 1, name: "Files" });
    await screen.findByText(/files? stored$/);
    expect(screen.queryByText(/^\d+ files?$/)).toBeNull();
    expect(screen.getByRole("button", { name: "Open" }).className).toContain("h-8");
  });

  test("UX-9: every variable's copy button says Copy, named for its variable", async () => {
    mount("/settings/environment-variables");
    const copies = await screen.findAllByRole("button", { name: /^Copy [A-Z_]/ });
    expect(copies.length).toBeGreaterThan(1);
    for (const c of copies) expect(c.textContent).toBe("Copy");
  });
});
