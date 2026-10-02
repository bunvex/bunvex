// UI-01 slice 7: every screen state passes axe, and the Database screen works from the keyboard alone.
import { describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const source = () =>
  new MockDataSource({ seed: 5, now: NOW, documents: { tasks: 12, users: 6, messages: 3, imports: 3 }, executions: 5 });

function mount(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={source()} history={history} />);
  return history;
}
const active = () => document.activeElement as HTMLElement;
const describeActive = () => `${active().tagName} ${active().getAttribute("role") ?? ""} ${active().textContent ?? ""}`;

/** Presses Tab until `match` has the focus (at most `max` times). */
async function tabTo(user: ReturnType<typeof userEvent.setup>, match: (el: HTMLElement) => boolean, max = 60) {
  for (let i = 0; i < max; i++) {
    await user.tab();
    if (match(active())) return active();
  }
  throw new Error(`never reached; last: ${describeActive()}`);
}

describe("every screen state passes axe", () => {
  const states: [string, string, string][] = [
    ["the overview", "/", "Overview"],
    ["a table", "/database/users", "users"],
    ["the schema panel", "/database/users?panel=schema", "users"],
    ["the indexes panel", "/database/users?panel=indexes", "users"],
    ["the columns panel", "/database/users?panel=columns", "users"],
    ["the add panel", "/database/users?panel=add", "users"],
    ["a table not in the schema", "/database/imports", "imports"],
    ["an unknown table", "/database/nope", "nope"],
    ["functions", "/functions", "Functions"],
    ["logs", "/logs", "Logs"],
  ];
  for (const [name, path, heading] of states)
    test(name, async () => {
      mount(path);
      await screen.findByRole("heading", { level: 1, name: heading });
      await expectAccessible();
    });
});

describe("the Database screen from the keyboard alone", () => {
  test("skip link, navigation, table list, grid, a document and back", async () => {
    const history = mount("/");
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    const user = userEvent.setup();

    // the first stop skips the navigation
    await user.tab();
    expect(active().textContent).toBe("Skip to content");
    await user.keyboard("{Enter}");
    expect(active().tagName).toBe("MAIN");

    // to the Database screen through the sidebar
    await tabTo(user, (el) => el.textContent === "Database");
    await user.keyboard("{Enter}");
    await screen.findByRole("heading", { level: 1, name: "imports" });

    // a table from the list
    await tabTo(user, (el) => el.tagName === "A" && (el.textContent ?? "").startsWith("users"));
    await user.keyboard("{Enter}");
    await screen.findByRole("heading", { level: 1, name: "users" });
    await waitFor(() => expect(history.location.pathname).toBe("/database/users"));

    // into the grid: one stop, on a visible current cell
    const first = await tabTo(user, (el) => el.getAttribute("role") === "gridcell");
    expect(first.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{ArrowRight}");
    const id = active().textContent!;
    expect(within(active()).getByRole("link")).toBeDefined(); // the _id cell

    // Enter on _id opens the document beside the grid; Escape closes it and the grid has the focus again
    await user.keyboard("{Enter}");
    await waitFor(() => expect(history.location.search).toContain(`doc=${id}`));
    await screen.findByRole("complementary", { name: new RegExp(id) });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(history.location.search).not.toContain("doc="));
    await waitFor(() => expect(active().getAttribute("role")).toBe("gridcell"));
    expect(active().textContent).toBe(id);
  });
});
