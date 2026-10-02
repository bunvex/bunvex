// The design language's section column (UI-01 §23) on each migrated screen, and the grouped main nav.
import { beforeEach, describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
function mount(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={new MockDataSource({ seed: 7, now: NOW, executions: 12 })} history={history} />);
  return history;
}
const column = () => document.querySelector('[data-slot="section-column"]') as HTMLElement;
const columnTitle = () => within(column()).getByRole("heading", { level: 2 }).textContent;

beforeEach(() => localStorage.clear());

describe("the main sidebar", () => {
  test("the screens in labelled groups, Settings last", async () => {
    mount("/");
    const nav = await screen.findByRole("navigation", { name: "Dashboard" });
    const group = (name: string) =>
      within(within(nav).getByRole("list", { name }))
        .getAllByRole("link")
        .map((a) => a.textContent);
    expect(group("Data")).toEqual(["Database", "Schema", "Files"]);
    // extensions join their group after the built-in entries (UI-01 §26): the mock offers Workflows and Analytics
    expect(group("Functions")).toEqual(["Functions", "Schedules", "Workflows"]);
    expect(group("Observe")).toEqual(["Logs", "History", "Analytics"]);
    expect(within(nav).getAllByRole("link").at(-1)?.textContent).toBe("Settings");
  });
});

describe("the section column", () => {
  test("Settings: the screen's name on top, its pages in groups, the current one marked; no tabs", async () => {
    mount("/settings/environment-variables");
    await screen.findByRole("heading", { level: 1, name: "Environment variables" });
    expect(columnTitle()).toBe("Settings");
    const pages = within(column()).getByRole("navigation", { name: "Settings" });
    expect(
      within(pages)
        .getAllByRole("heading")
        .map((h) => h.textContent),
    ).toEqual(["Configuration", "Data", "Extensions"]); // pages an extension adds: Analytics → Map style
    expect(within(pages).getByRole("link", { name: "Environment variables" }).getAttribute("aria-current")).toBe(
      "page",
    );
    await userEvent.setup().click(within(pages).getByRole("link", { name: "Snapshots" }));
    await screen.findByRole("heading", { level: 1, name: "Snapshots" });
    await expectAccessible();
  });

  test("Schedules: the pages, then the filters on Scheduled functions only", async () => {
    const history = mount("/schedules/functions");
    await screen.findByRole("heading", { level: 1, name: "Scheduled functions" });
    expect(columnTitle()).toBe("Schedules");
    expect(within(column()).getByRole("navigation", { name: "Schedule filters" })).toBeDefined();
    await userEvent.setup().click(within(column()).getByRole("link", { name: "Cron jobs" }));
    await waitFor(() => expect(history.location.pathname).toBe("/schedules/crons"));
    expect(within(column()).queryByRole("navigation", { name: "Schedule filters" })).toBeNull();
  });

  test("Database, Logs and History use the same column", async () => {
    mount("/database/tasks");
    await screen.findByRole("heading", { level: 1, name: "tasks" });
    expect(columnTitle()).toBe("Database");
    expect(within(column()).getByRole("navigation", { name: "Tables" })).toBeDefined();
    cleanup();
    mount("/logs");
    await screen.findByRole("heading", { level: 1, name: "Logs" });
    expect(columnTitle()).toBe("Logs");
    expect(within(column()).getByRole("navigation", { name: "Log filters" })).toBeDefined();
    cleanup();
    mount("/history");
    await screen.findByRole("heading", { level: 1, name: "History" });
    expect(columnTitle()).toBe("History");
  });

  test("on a phone, the column's content is a sheet behind a button in Bar 1", async () => {
    mount("/settings/general");
    await screen.findByRole("heading", { level: 1, name: "General" });
    // named after what it holds: the screen's pages here, "Filters" where it holds filters only (UX2-13)
    await userEvent.setup().click(screen.getByRole("button", { name: "Settings" }));
    const sheet = await screen.findByRole("complementary", { name: "Settings" });
    await userEvent.setup().click(within(sheet).getByRole("link", { name: "Snapshots" }));
    await screen.findByRole("heading", { level: 1, name: "Snapshots" });
    expect(screen.queryByRole("complementary", { name: "Settings" })).toBeNull(); // a pick closes it
  });

  test("the nav has a heading only with more than one group or filters below it (UX2-22)", async () => {
    mount("/schedules/crons");
    await screen.findByRole("heading", { level: 1, name: "Cron jobs" });
    const nav = () => screen.getAllByRole("navigation", { name: "Schedules" })[0]!;
    expect(within(nav()).queryByRole("heading")).toBeNull();
    cleanup();
    mount("/schedules/functions");
    await screen.findByRole("heading", { level: 1, name: "Scheduled functions" });
    expect(within(nav()).getByRole("heading", { name: "Views" })).toBeDefined();
  });
});
