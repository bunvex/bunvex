import { describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { encodeFilter } from "../src/database/filter-url.ts";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const mockSource = () =>
  new MockDataSource({
    seed: 5,
    now: NOW,
    documents: { tasks: 60, users: 6, messages: 4, imports: 5 },
    executions: 10,
  });

function mount(path: string, source = mockSource()) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={source} history={history} />);
  return { history, source };
}
const heading = (name: string) => screen.findByRole("heading", { level: 1, name });
const docsTable = (table: string) => screen.getByRole("grid", { name: `Documents in ${table}` });
const bodyRows = (t: HTMLElement) => within(t).getAllByRole("row").slice(1);
const column = (t: HTMLElement, name: string) => {
  const i = within(t)
    .getAllByRole("columnheader")
    .findIndex((h) => h.textContent === name);
  return bodyRows(t).map((r) => within(r).getAllByRole("gridcell")[i]!.textContent);
};

describe("the Database screen", () => {
  test("/database opens the first table; the sidebar lists every table with its size", async () => {
    const { history } = mount("/database");
    await heading("imports");
    expect(history.location.pathname).toBe("/database/imports");
    const nav = screen.getByRole("navigation", { name: "Tables" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "imports* (not in the schema)5",
      "messages4",
      "tasks60",
      "users6",
    ]);
    expect(links[0]!.getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("Not in the schema")).toBeDefined();
    await expectAccessible();
  });

  test("columns: _id first, fields as they appear, _creationTime last; newest first", async () => {
    const { source } = mount("/database/tasks");
    await heading("tasks");
    const t = docsTable("tasks");
    expect(
      within(t)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["", "_id", "text", "done", "owner", "priority", "tags", "_creationTime"]); // "": the selection checkbox
    const newest = (await source.listDocuments({ table: "tasks", numItems: 1, cursor: null })).page[0]!;
    expect(within(bodyRows(t)[0]!).getByRole("link").textContent).toBe(newest._id);
    expect(screen.getByText("60 of 60 documents loaded")).toBeDefined();
  });

  test("a filter built in the bar is applied, and written to the URL", async () => {
    const { history } = mount("/database/tasks");
    await heading("tasks");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add filter" }));
    await user.click(screen.getByRole("combobox", { name: "Field" }));
    await user.click(await screen.findByRole("option", { name: "done" }));
    await user.type(screen.getByRole("textbox", { name: "done value" }), "true");
    await waitFor(() => expect(history.location.search).toContain("filter="));
    await waitFor(() => {
      const done = column(docsTable("tasks"), "done");
      expect(done.length).toBeGreaterThan(0);
      expect(new Set(done)).toEqual(new Set(["true"]));
    });
    expect(screen.getByText(/matching documents?$/)).toBeDefined();
  });

  test("a link with a filter opens filtered, with the bar showing it", async () => {
    const source = mockSource();
    const [user] = (await source.listDocuments({ table: "users", numItems: 1, cursor: null })).page;
    const filter = encodeFilter({
      index: { name: "by_owner", eq: [{ value: user!._id, enabled: true }] },
      clauses: [],
      order: "asc",
    });
    mount(`/database/tasks?filter=${filter}`, source);
    await heading("tasks");
    expect((screen.getByRole("textbox", { name: "owner equals" }) as HTMLInputElement).value).toBe(user!._id);
    await waitFor(() => expect(new Set(column(docsTable("tasks"), "owner"))).toEqual(new Set([user!._id])));
  });

  test("a filter the table cannot serve is shown, not a broken screen", async () => {
    mount(`/database/tasks?filter=${encodeFilter({ index: { name: "by_text", eq: [] }, clauses: [], order: "asc" })}`);
    await heading("tasks");
    expect((await screen.findAllByRole("alert")).some((a) => /backfilling/.test(a.textContent ?? ""))).toBe(true);
  });

  test("a link whose filter cannot be read opens unfiltered, and says so", async () => {
    mount("/database/tasks?filter=not-a-filter");
    await heading("tasks");
    expect(screen.getByText(/could not be read; showing every document/)).toBeDefined();
  });

  test("Enter on a row's _id opens the document beside the table; Escape closes it", async () => {
    const { history } = mount("/database/users");
    await heading("users");
    const row = bodyRows(docsTable("users"))[0]!;
    const id = within(row).getByRole("link").textContent!;
    const user = userEvent.setup();
    await user.tab(); // into the table list's search box
    await user.click(within(row).getAllByRole("gridcell")[2]!);
    await user.keyboard("{ArrowLeft}{Enter}"); // the _id cell: not editable, so Enter opens the document
    const panel = await screen.findByRole("complementary", { name: id });
    expect(within(panel).getByLabelText(`Document ${id}`).textContent).toContain(`"_id": "${id}"`);
    expect(history.location.search).toContain(`doc=${id}`);
    await expectAccessible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("complementary", { name: id })).toBeNull());
    expect(history.location.search).not.toContain("doc=");
  });

  test("the schema and indexes panels", async () => {
    mount("/database/imports?panel=schema");
    await heading("imports");
    expect((await screen.findByRole("complementary", { name: "Schema of imports" })).textContent).toContain(
      "is not in the schema",
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: /^tasks/ }));
    await heading("tasks");
    await user.click(screen.getByRole("button", { name: "Indexes" }));
    const panel = await screen.findByRole("complementary", { name: "Indexes of tasks" });
    expect(panel.textContent).toContain("by_done_priority");
    expect(panel.textContent).toMatch(/backfilling.*documents indexed/);
  });

  test("live: a document written elsewhere appears at the top, and the count follows", async () => {
    const { source } = mount("/database/tasks");
    await heading("tasks");
    expect(screen.getByText("60 documents")).toBeDefined();
    let added = "";
    act(() => {
      added = source.insertDocument("tasks", { text: "written elsewhere", done: false })._id;
    });
    await waitFor(() => expect(within(bodyRows(docsTable("tasks"))[0]!).getByRole("link").textContent).toBe(added));
    await waitFor(() => expect(screen.getByText("61 documents")).toBeDefined());
    expect(
      within(screen.getByRole("navigation", { name: "Tables" })).getByRole("link", { name: /^tasks/ }).textContent,
    ).toBe("tasks61");
  });

  test("live: a value changed elsewhere flashes its cell, and is announced", async () => {
    const { source } = mount("/database/users");
    await heading("users");
    const first = bodyRows(docsTable("users"))[0]!;
    const id = within(first).getByRole("link").textContent!;
    await act(() => source.patchDocuments("users", [id], { name: "Changed in another tab" }));
    const cell = await screen.findByText("Changed in another tab");
    expect(cell.closest("td")?.hasAttribute("data-changed")).toBe(true);
    expect(screen.getAllByRole("status").some((s) => s.textContent === "1 document changed")).toBe(true);
  });

  test("an unknown table says so, with the table list still there", async () => {
    mount("/database/ghosts");
    await heading("ghosts");
    expect(screen.getByText(/There is no table named “ghosts”/)).toBeDefined();
    expect(screen.getByRole("navigation", { name: "Tables" })).toBeDefined();
  });
});

describe("editing in the grid", () => {
  /** Tabs into the grid and walks to the cell of `field` on the first row. */
  async function toCell(user: ReturnType<typeof userEvent.setup>, table: string, field: string) {
    const t = docsTable(table);
    const headers = within(t)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    // start on the _id cell (column 1: column 0 is the selection checkbox)
    await user.click(within(bodyRows(t)[0]!).getAllByRole("gridcell")[1]!);
    for (let i = 1; i < headers.indexOf(field); i++) await user.keyboard("{ArrowRight}");
    return bodyRows(t)[0]!;
  }

  test("Enter edits, Enter saves to the source, and the keyboard keeps navigating", async () => {
    const { source } = mount("/database/users");
    await heading("users");
    const user = userEvent.setup();
    const row = await toCell(user, "users", "name");
    const id = within(row).getByRole("link").textContent!;
    await user.keyboard("{Enter}");
    const input = screen.getByRole("textbox", { name: "Edit name" });
    await user.clear(input);
    await user.type(input, "Grace Hopper{Enter}");
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Edit name" })).toBeNull());
    expect((await source.getDocument("users", id))?.name).toBe("Grace Hopper");
    expect((document.activeElement as HTMLElement).textContent).toBe("Grace Hopper");
    await user.keyboard("{ArrowDown}");
    expect((document.activeElement as HTMLElement).getAttribute("role")).toBe("gridcell");
    await expectAccessible();
  });

  test("a value that does not parse keeps the editor open with the reason; Escape leaves it unchanged", async () => {
    const { source } = mount("/database/users");
    await heading("users");
    const user = userEvent.setup();
    const row = await toCell(user, "users", "admin");
    const id = within(row).getByRole("link").textContent!;
    const before = (await source.getDocument("users", id))?.admin;
    await user.keyboard("{Enter}");
    const input = screen.getByRole("textbox", { name: "Edit admin" });
    await user.clear(input);
    await user.type(input, "[[1,{Enter}"); // "[[" types one "["
    expect(screen.getByRole("alert").textContent).toBe("Not valid JSON");
    expect(screen.getByRole("textbox", { name: "Edit admin" })).toBeDefined();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect((await source.getDocument("users", id))?.admin).toBe(before);
  });

  test("typed values keep their type; an empty box removes the field", async () => {
    const { source } = mount("/database/users");
    await heading("users");
    const user = userEvent.setup();
    const row = await toCell(user, "users", "email");
    const id = within(row).getByRole("link").textContent!;
    await user.keyboard("{Enter}");
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "42{Tab}"); // Tab: save and move right
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect((await source.getDocument("users", id))?.email).toBe(42);
    await user.keyboard("{ArrowLeft}{Enter}");
    await user.clear(screen.getByRole("textbox"));
    await user.keyboard("{Enter}");
    await waitFor(async () => expect("email" in ((await source.getDocument("users", id)) ?? {})).toBe(false));
  });

  test("system fields are not editable: Enter opens the document", async () => {
    const { history } = mount("/database/users");
    await heading("users");
    const user = userEvent.setup();
    const row = await toCell(user, "users", "_creationTime");
    const id = within(row).getByRole("link").textContent!;
    expect((document.activeElement as HTMLElement).getAttribute("aria-readonly")).toBe("true");
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("textbox")).toBeNull();
    await waitFor(() => expect(history.location.search).toContain(`doc=${id}`));
  });

  test("a read-only credential cannot edit, and the screen says so", async () => {
    const source = new MockDataSource({
      seed: 5,
      now: NOW,
      documents: { users: 3 },
      capabilities: { operations: ["viewData", "writeData"], readOnly: true },
    });
    mount("/database/users", source);
    await heading("users");
    await screen.findByText("Read-only");
    const user = userEvent.setup();
    await toCell(user, "users", "name");
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  test("a value the source refuses keeps the editor open with its reason", async () => {
    const source = mockSource();
    source.patchDocuments = () => Promise.reject(new Error("document too large"));
    mount("/database/users", source);
    await heading("users");
    const user = userEvent.setup();
    await toCell(user, "users", "name");
    await user.keyboard("{Enter}");
    await user.type(screen.getByRole("textbox"), "!{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe("document too large");
    expect(screen.getByRole("textbox", { name: "Edit name" })).toBeDefined();
  });
});
