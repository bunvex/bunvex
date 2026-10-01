// The UX review's shared-component fixes as the screens use them (UI-01 §20.5).
import { describe, expect, mock, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";

const NOW = Date.UTC(2026, 8, 29, 12);
function mount(path: string) {
  const source = new MockDataSource({ seed: 5, now: NOW, documents: { users: 6, tasks: 5 }, liveWritesMs: 0 });
  render(<Dashboard dataSource={source} history={createMemoryHistory({ initialEntries: [path] })} />);
  return source;
}

describe("shared components after the UX review", () => {
  test("UX-7: the schema panel's Saved / Generated are underlined tabs", async () => {
    mount("/database/tasks?panel=schema");
    const tab = await screen.findByRole("tab", { name: "Saved" });
    expect(tab.closest("[data-variant]")?.getAttribute("data-variant")).toBe("line");
  });

  test("UX-10: a variable's Delete is quiet but red; Pause deployment is outlined in red", async () => {
    mount("/settings/environment-variables");
    const del = (await screen.findAllByRole("button", { name: /^Delete [A-Z_]/ }))[0]!;
    expect(del.className).toContain("text-destructive");
    expect(del.className).not.toContain("bg-destructive/10 text-destructive hover:bg-destructive/20");
  });

  test("UX-11: a log line's outcome is the shared status badge", async () => {
    mount("/logs");
    await screen.findByRole("heading", { level: 1, name: "Logs" });
    const badge = (await screen.findAllByText(/^(Success|Failure)$/))[0]!.closest("[data-slot=status-badge]");
    expect(badge?.textContent).toMatch(/^(Success|Failure) \d+ ms$/);
  });

  test("UX-19: the open function is scrolled into view inside the tree", async () => {
    const scrolled = mock(function (this: Element) {
      return this;
    });
    const real = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrolled as unknown as typeof real;
    try {
      mount("/functions?function=tasks:toggle");
      await screen.findByRole("heading", { level: 1, name: "toggle" });
      const nav = screen.getByRole("navigation", { name: "Functions" });
      const current = within(nav).getByRole("link", { current: "page" });
      expect(scrolled.mock.contexts).toContain(current);
    } finally {
      Element.prototype.scrollIntoView = real;
    }
  });
});
