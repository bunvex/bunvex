// The system tables on the Database screen (STUDY-131 AD-24): a "Show system tables" switch for a credential
// that may view data, the list it opens, a system table's documents read-only, and the mock's part of the
// contract (also run by mock.test.ts) without the `viewData` operation.
import { afterEach, describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describeSystemTablesContract } from "../src/contract-system-tables.ts";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 9, 5, 12);
const source = (opts: Partial<ConstructorParameters<typeof MockDataSource>[0]> = {}) =>
  new MockDataSource({
    seed: 5,
    now: NOW,
    documents: { tasks: 6, users: 3, messages: 2, imports: 2 },
    executions: 5,
    ...opts,
  });

function mount(path: string, src = source()) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={src} history={history} />);
  return { history, src };
}

afterEach(() => {
  cleanup();
  try {
    localStorage.clear();
  } catch {}
});

describe("the contract's system-table part, without viewData", () =>
  describeSystemTablesContract({
    make: () => source({ capabilities: { operations: ["viewLogs"], readOnly: true } }),
    test,
  }));

describe("system tables on the Database screen", () => {
  test("the switch lists every system table under the user tables; off again, they go", async () => {
    mount("/database/tasks");
    await screen.findByRole("heading", { level: 1, name: "tasks" });
    expect(screen.queryByRole("list", { name: "System tables" })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "Show system tables" }));
    const list = await screen.findByRole("list", { name: "System tables" });
    await waitFor(() => expect(within(list).getAllByRole("link").length).toBeGreaterThan(3));
    const names = within(list)
      .getAllByRole("link")
      .map((l) => l.textContent ?? "");
    expect(names.every((n) => n.startsWith("_"))).toBe(true);
    expect(names.some((n) => n.startsWith("_tables"))).toBe(true);
    await expectAccessible();
    await user.click(screen.getByRole("checkbox", { name: "Show system tables" }));
    await waitFor(() => expect(screen.queryByRole("list", { name: "System tables" })).toBeNull());
  });

  test("a private system table: its documents, every field, read-only, with its description", async () => {
    const { src } = mount("/database/_tables");
    await screen.findByRole("heading", { level: 1, name: "_tables" });
    expect(screen.getByText("Private system table")).toBeDefined();
    expect(screen.getByText("Read-only")).toBeDefined();
    expect(await screen.findByText(/^Every table: its name, number and state/)).toBeDefined();
    const grid = await screen.findByRole("table", { name: "Documents in _tables" });
    // the user tables are rows of `_tables`
    await waitFor(() => expect(grid.textContent).toContain("tasks"));
    const headers = within(grid)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual(expect.arrayContaining(["_id", "name", "number", "state", "tablet"]));
    // nothing to edit: no checkbox column, no add button, no editor on a double click
    expect(headers[0]).toBe("_id");
    expect(screen.queryByRole("button", { name: /Add documents/ })).toBeNull();
    // the open system table keeps the list shown, and the table it names is current
    const list = screen.getByRole("list", { name: "System tables" });
    await waitFor(() =>
      expect(
        within(list)
          .getByRole("link", { name: /^_tables/ })
          .getAttribute("aria-current"),
      ).toBe("page"),
    );
    const all = await src.listSystemDocuments({ table: "_tables", numItems: 100, cursor: null });
    expect(screen.getByText(`${all.page.length} documents loaded`)).toBeDefined();
  });

  test("newest first on demand", async () => {
    const { src } = mount("/database/_index");
    await screen.findByRole("heading", { level: 1, name: "_index" });
    const grid = await screen.findByRole("table", { name: "Documents in _index" });
    const newest = (await src.listSystemDocuments({ table: "_index", numItems: 1, cursor: null, order: "desc" }))
      .page[0]!;
    await userEvent.setup().click(screen.getByRole("button", { name: "Oldest first" }));
    await screen.findByRole("button", { name: "Newest first" });
    await waitFor(() => {
      const first = within(grid).getAllByRole("row")[1]!;
      expect(first.textContent).toContain(newest._id);
    });
  });

  test("a credential that may not view data gets no switch and no system table", async () => {
    mount("/database/_tables", source({ capabilities: { operations: ["viewLogs", "viewMetrics"], readOnly: true } }));
    await screen.findByRole("heading", { level: 1, name: "_tables" });
    await waitFor(() =>
      expect(screen.getByText("System tables are shown only to a credential that may view data.")).toBeDefined(),
    );
    expect(screen.queryByRole("checkbox", { name: "Show system tables" })).toBeNull();
    expect(screen.queryByRole("table", { name: "Documents in _tables" })).toBeNull();
  });

  test("the mock's system tables follow its state: a new table shows in `_tables`", async () => {
    const src = source();
    const before = await src.listSystemDocuments({ table: "_tables", numItems: 100, cursor: null });
    await src.createTable("scratch");
    const after = await src.listSystemDocuments({ table: "_tables", numItems: 100, cursor: null });
    expect(after.page.length).toBe(before.page.length + 1);
    expect(after.page.some((d) => d.name === "tasks")).toBe(true);
  });
});
