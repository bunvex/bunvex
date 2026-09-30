import { describe, expect, mock, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clipboardText, filterOps, withClause } from "../src/database/cell-menu.tsx";
import { decodeFilter } from "../src/database/filter-url.ts";
import { encodeInt64 } from "../src/filters.ts";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const source = (opts: Partial<ConstructorParameters<typeof MockDataSource>[0]> = {}) =>
  new MockDataSource({ seed: 5, now: NOW, documents: { tasks: 20, users: 6, messages: 3, imports: 3 }, ...opts });

function mount(path: string, src = source()) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={src} history={history} />);
  return { history, src };
}
const heading = (name: string) => screen.findByRole("heading", { level: 1, name });
const grid = (table: string) => screen.getByRole("grid", { name: `Documents in ${table}` });
const bodyRows = (t: HTMLElement) => within(t).getAllByRole("row").slice(1);
const colIndex = (t: HTMLElement, field: string) =>
  within(t)
    .getAllByRole("columnheader")
    .findIndex((h) => h.textContent === field);
/** Focuses a field's cell in the first row, by clicking it. */
async function toCell(user: ReturnType<typeof userEvent.setup>, table: string, field: string) {
  const t = grid(table);
  const row = bodyRows(t)[0]!;
  const cell = within(row).getAllByRole("gridcell")[colIndex(t, field)]!;
  await user.click(cell);
  await waitFor(() => expect(document.activeElement).toBe(cell));
  return row;
}
const idOf = (row: HTMLElement) => within(row).getByRole("link").textContent!;
function stubClipboard() {
  const writeText = mock((_: string) => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

describe("what a cell offers", () => {
  test("filters that make sense for the value, as Convex offers them", () => {
    expect(filterOps("name", "Ada")).toEqual(["eq", "neq", "gt", "gte", "lt", "lte", "type", "notype"]);
    expect(filterOps("admin", true)).toEqual(["eq", "neq", "type", "notype"]);
    expect(filterOps("tags", ["a"])).toEqual(["eq", "neq", "type", "notype"]);
    expect(filterOps("email", undefined)).toEqual(["type", "notype"]);
    expect(filterOps("email", null)).toEqual(["type", "notype"]);
    expect(filterOps("_id", "k1")).toEqual(["eq", "neq"]);
    expect(filterOps("_creationTime", 1)).toEqual(["gt", "gte", "lt", "lte"]);
  });

  test("text is copied as it is; anything else as a literal", () => {
    expect(clipboardText("ada@example.com")).toBe("ada@example.com");
    expect(clipboardText(encodeInt64(10n))).toBe("10n");
    expect(clipboardText({ a: [1] })).toBe("{\n  a: [\n    1,\n  ],\n}");
    expect(clipboardText(undefined)).toBe("undefined");
  });

  test("a clause joins the applied filter with an id of its own", () => {
    const one = withClause(null, { field: "a", op: "eq", value: 1 });
    expect(one).toEqual({ clauses: [{ id: "c1", field: "a", op: "eq", value: 1, enabled: true }], order: "desc" });
    const two = withClause(
      { ...one, clauses: [{ ...one.clauses[0]!, id: "c2" }] },
      { field: "b", op: "type", value: "null" },
    );
    expect(two.clauses.map((c) => c.id)).toEqual(["c2", "c3"]);
  });
});

describe("a cell's context menu and shortcuts on the Database screen", () => {
  test("Filter by this value adds a clause to the URL, and the list follows it", async () => {
    const { history } = mount("/database/users");
    await heading("users");
    const user = userEvent.setup();
    const row = await toCell(user, "users", "admin");
    const value = within(row).getAllByRole("gridcell")[colIndex(grid("users"), "admin")]!.textContent;
    await user.keyboard("{Shift>}{F10}{/Shift}");
    const menu = await screen.findByRole("menu", { name: "Actions on admin" });
    await expectAccessible(menu);
    // the keyboard way in: the first item is Filter by, and Right opens its submenu
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("Filter by admin");
    await user.keyboard("{ArrowRight}");
    await user.click(await screen.findByRole("menuitem", { name: `equals ${value}` }));
    await waitFor(() => expect(history.location.search).toContain("filter="));
    const filter = decodeFilter(new URLSearchParams(history.location.search).get("filter") ?? undefined);
    expect(filter?.clauses).toEqual([{ id: "c1", field: "admin", op: "eq", value: value === "true", enabled: true }]);
    await waitFor(() => {
      const t = grid("users");
      const i = colIndex(t, "admin");
      expect(new Set(bodyRows(t).map((r) => within(r).getAllByRole("gridcell")[i]!.textContent))).toEqual(
        new Set([value]),
      );
    });
  });

  test("Ctrl+C copies the value, Ctrl+Shift+C the document, and says so", async () => {
    const src = source();
    mount("/database/users", src);
    await heading("users");
    const user = userEvent.setup();
    const writeText = stubClipboard();
    const row = await toCell(user, "users", "email");
    const doc = (await src.getDocument("users", idOf(row)))!;
    await user.keyboard("{Control>}c{/Control}");
    expect(writeText).toHaveBeenLastCalledWith(doc.email as string);
    expect(await screen.findByText("Copied email.")).toBeDefined();
    await user.keyboard("{Control>}{Shift>}c{/Shift}{/Control}");
    expect(writeText.mock.calls.at(-1)![0]).toStartWith(`{\n  _id: "${doc._id}",`);
    expect(await screen.findByText("Copied the document.")).toBeDefined();
  });

  test("Shift+Space opens the document; Shift+Enter opens it in its editor", async () => {
    const { history } = mount("/database/users");
    await heading("users");
    const user = userEvent.setup();
    const row = await toCell(user, "users", "name");
    const id = idOf(row);
    await user.keyboard("{Shift>} {/Shift}");
    await waitFor(() => expect(history.location.search).toContain(`doc=${id}`));
    expect(screen.queryByRole("textbox", { name: `Fields of ${id}` })).toBeNull();
    await toCell(user, "users", "name");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(await screen.findByRole("textbox", { name: `Fields of ${id}` })).toBeDefined();
  });

  test("the menu's Edit document opens the editor too; read-only offers no editing", async () => {
    mount("/database/users");
    await heading("users");
    const user = userEvent.setup();
    const row = await toCell(user, "users", "name");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.click(await screen.findByRole("menuitem", { name: "Edit document" }));
    expect(await screen.findByRole("textbox", { name: `Fields of ${idOf(row)}` })).toBeDefined();
  });

  test("read-only: the edit items are disabled and Shift+Enter does nothing", async () => {
    mount("/database/users", source({ capabilities: { operations: ["viewData"], readOnly: false } }));
    await heading("users");
    const user = userEvent.setup();
    await toCell(user, "users", "name");
    await user.keyboard("{Shift>}{F10}{/Shift}");
    const menu = await screen.findByRole("menu");
    for (const name of ["Edit name", "Edit document"])
      expect(within(menu).getByRole("menuitem", { name }).getAttribute("aria-disabled")).toBe("true");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
