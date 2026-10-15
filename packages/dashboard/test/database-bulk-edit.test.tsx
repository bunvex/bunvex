// Bulk edit on the Database screen (STUDY-149 "Bulk edit"), as Convex's toolbar and `EditFieldsPanel.tsx`: the
// header's checkbox on a table still paging selects every document, and "Edit all" patches the whole table in one
// call (patchAllDocuments, Convex's `patchDocumentsFields` without ids); some selected documents are patched by id;
// a filter never edits "all".
import { describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { DataSourceError, type Document, type FieldPatch } from "@bunvex/dashboard/data-source";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { checkFieldPatch } from "../src/database/bulk-edit.tsx";
import { encodeFilter } from "../src/database/filter-url.ts";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);

/** A mock whose patches are recorded: `all` for patchAllDocuments, the ids for patchDocuments. */
function source(documents: Partial<Record<"users" | "tasks" | "messages" | "imports", number>> = {}) {
  const src = new MockDataSource({
    seed: 5,
    now: NOW,
    documents: { tasks: 250, users: 6, messages: 3, imports: 3, ...documents },
    executions: 5,
  });
  const calls: { target: string[] | "all"; fields: Record<string, FieldPatch> }[] = [];
  const patchAll = src.patchAllDocuments.bind(src);
  const patch = src.patchDocuments.bind(src);
  src.patchAllDocuments = (table, fields, o) => {
    calls.push({ target: "all", fields });
    return patchAll(table, fields, o);
  };
  src.patchDocuments = (table, ids, fields, o) => {
    calls.push({ target: ids, fields });
    return patch(table, ids, fields, o);
  };
  return { src, calls };
}

function mount(path: string, src: MockDataSource) {
  render(<Dashboard dataSource={src} history={createMemoryHistory({ initialEntries: [path] })} />);
}
const heading = (name: string) => screen.findByRole("heading", { level: 1, name });
const every = async (src: MockDataSource, table: string): Promise<Document[]> => {
  const out: Document[] = [];
  let cursor: string | null = null;
  for (;;) {
    const p = await src.listDocuments({ table, numItems: 500, cursor });
    out.push(...p.page);
    if (p.isDone) return out;
    cursor = p.continueCursor;
  }
};
const grid = (table: string) => screen.getByRole("grid", { name: `Documents in ${table}` });
const button = (name: string | RegExp) => screen.getByRole("button", { name });

describe("the fields a bulk edit changes", () => {
  test("an object; a field given undefined is removed; system fields are refused", () => {
    expect(checkFieldPatch("{ a: 1, gone: undefined, n: 2n }")).toEqual({
      ok: true,
      fields: { a: 1, n: { $integer: "AgAAAAAAAAA=" }, gone: { $unset: true } },
      count: 3,
    });
    // a nested undefined is not a removal: the field is the object without it
    expect(checkFieldPatch("{ o: { x: undefined, y: 1 } }")).toEqual({ ok: true, fields: { o: { y: 1 } }, count: 1 });
    expect(checkFieldPatch("{\n  \n}")).toEqual({ ok: true, fields: {}, count: 0 });
    expect(checkFieldPatch("[1]")).toMatchObject({
      ok: false,
      error: expect.stringContaining("fields to change as an object"),
    });
    expect(checkFieldPatch("undefined")).toMatchObject({ ok: false });
    expect(checkFieldPatch("{ _id: 1 }")).toEqual({
      ok: false,
      error: '"_id" is a system field; it cannot be changed here.',
    });
    expect(checkFieldPatch("{ a: }")).toMatchObject({ ok: false, offset: 5 });
  });
});

describe("bulk edit", () => {
  test("a table still paging: the header selects every document, and Edit all patches the whole table at once", async () => {
    const { src, calls } = source();
    mount("/database/tasks", src);
    await heading("tasks");
    const user = userEvent.setup();
    await user.click(within(grid("tasks")).getByRole("checkbox", { name: "Select all documents" }));
    // every checkbox shows it, loaded or not; Convex's words on the buttons
    expect(
      within(grid("tasks"))
        .getAllByRole("checkbox")
        .every((b) => b.getAttribute("aria-checked") === "true"),
    ).toBe(true);
    expect(button("Delete all")).toBeDefined();
    await user.click(button("Edit all"));
    const panel = await screen.findByRole("complementary", { name: "Bulk edit all documents in tasks" });
    expect(within(panel).getByText("Overwrite existing fields")).toBeDefined();
    expect(within(panel).getByText(/Remove existing fields by setting them to/)).toBeDefined();
    const apply = within(panel).getByRole("button", { name: "Apply" });
    expect(apply.hasAttribute("disabled")).toBe(true); // nothing to change yet
    fireEvent.change(within(panel).getByRole("textbox", { name: "Fields to change" }), {
      target: { value: "{ reviewed: true, tags: undefined }" },
    });
    await expectAccessible();
    await user.click(apply);
    await screen.findByText("Edited all documents in tasks.");
    expect(screen.queryByRole("complementary", { name: /^Bulk edit/ })).toBeNull();
    expect(calls).toEqual([{ target: "all", fields: { reviewed: true, tags: { $unset: true } } }]);
    const docs = await every(src, "tasks");
    expect(docs.length).toBe(250);
    expect(docs.every((d) => d.reviewed === true && !("tags" in d))).toBe(true);
  });

  test("the header again clears it; a row's checkbox leaves 'all' for the loaded rows less that one", async () => {
    const { src } = source();
    mount("/database/tasks", src);
    await heading("tasks");
    const user = userEvent.setup();
    const all = () => within(grid("tasks")).getByRole("checkbox", { name: "Select all documents" });
    await user.click(all());
    await user.click(all());
    expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
    await user.click(all());
    const rows = within(grid("tasks")).getAllByRole("checkbox").slice(1);
    await user.click(rows[0]!);
    expect(rows[0]!.getAttribute("aria-checked")).toBe("false");
    // the loaded ones, less one, by id: no longer "all"
    expect(button("Edit 99")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Delete all" })).toBeNull();
  });

  test("a table fully loaded: the header selects its documents, and with all of them selected it is Edit all", async () => {
    const { src, calls } = source();
    mount("/database/users", src);
    await heading("users");
    const user = userEvent.setup();
    await user.click(within(grid("users")).getByRole("checkbox", { name: "Select all documents" }));
    await user.click(button("Edit all"));
    const panel = await screen.findByRole("complementary", { name: "Bulk edit all documents in users" });
    fireEvent.change(within(panel).getByRole("textbox"), { target: { value: "{ team: 'core' }" } });
    await user.click(within(panel).getByRole("button", { name: "Apply" }));
    await screen.findByText("Edited all documents in users.");
    expect(calls.map((c) => c.target)).toEqual(["all"]);
  });

  test("some selected: Edit 2 patches those two by id, and nothing else", async () => {
    const { src, calls } = source();
    mount("/database/users", src);
    await heading("users");
    const user = userEvent.setup();
    const boxes = within(grid("users")).getAllByRole("checkbox").slice(1);
    await user.click(boxes[0]!);
    await user.click(boxes[1]!);
    await user.click(button("Edit 2"));
    const panel = await screen.findByRole("complementary", { name: "Bulk edit 2 documents in users" });
    fireEvent.change(within(panel).getByRole("textbox"), { target: { value: "{ flagged: true }" } });
    await user.click(within(panel).getByRole("button", { name: "Apply" }));
    await screen.findByText("Edited 2 documents in users.");
    expect(calls.length).toBe(1);
    const ids = calls[0]!.target as string[];
    expect(ids.length).toBe(2);
    const docs = await every(src, "users");
    expect(docs.filter((d) => d.flagged === true).map((d) => d._id)).toEqual(
      docs.filter((d) => ids.includes(d._id)).map((d) => d._id),
    );
    // the button again closes the panel, as Convex's
    await user.click(button("Edit 2"));
    await user.click(button("Edit 2"));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: /^Bulk edit/ })).toBeNull());
  });

  test("one selected: Edit opens that document's own editor", async () => {
    const { src } = source();
    mount("/database/users", src);
    await heading("users");
    const user = userEvent.setup();
    await user.click(within(grid("users")).getAllByRole("checkbox")[1]!);
    await user.click(button("Edit"));
    const panel = await screen.findByRole("complementary");
    expect(within(panel).getByRole("textbox", { name: /^Fields of / })).toBeDefined();
  });

  test("a filter: no 'select all' while its matches are still paging; loaded, they are edited by id, never all", async () => {
    const { src, calls } = source();
    const clause = (id: string, field: string, value: boolean | number) => ({
      id,
      field,
      op: "eq" as const,
      value,
      enabled: true,
    });
    // most tasks are not done: more matches than one page
    mount(`/database/tasks?filter=${encodeFilter({ clauses: [clause("d", "done", false)], order: "desc" })}`, src);
    await heading("tasks");
    await waitFor(() => expect(within(grid("tasks")).getAllByRole("checkbox").length).toBeGreaterThan(1));
    expect(within(grid("tasks")).queryByRole("checkbox", { name: /^Select every/ })).toBeNull();
    // a filter whose matches fit a page: the header selects them, and Edit names how many
    cleanupAndMount(
      `/database/tasks?filter=${encodeFilter({ clauses: [clause("p", "priority", 1)], order: "desc" })}`,
      src,
    );
    await heading("tasks");
    const user = userEvent.setup();
    const header = await within(grid("tasks")).findByRole("checkbox", { name: "Select every matching document" });
    await user.click(header);
    const matches = (await every(src, "tasks")).filter((d) => d.priority === 1);
    await user.click(button(`Edit ${matches.length}`));
    expect(screen.queryByRole("button", { name: "Delete all" })).toBeNull();
    const panel = await screen.findByRole("complementary", {
      name: `Bulk edit ${matches.length} documents in tasks`,
    });
    fireEvent.change(within(panel).getByRole("textbox"), { target: { value: "{ urgent: true }" } });
    await user.click(within(panel).getByRole("button", { name: "Apply" }));
    await screen.findByText(`Edited ${matches.length} documents in tasks.`);
    expect(new Set(calls[0]!.target)).toEqual(new Set(matches.map((d) => d._id)));
    expect((await every(src, "tasks")).filter((d) => d.urgent === true).length).toBe(matches.length);
  });

  test("a refusal: the deployment's words, the panel and the draft kept; anything else with the advice", async () => {
    const { src } = source();
    let failure = new DataSourceError(
      "invalid_request",
      'Failed to insert or update a document in table "tasks" because it does not match the schema: Value does not match validator.',
    );
    src.patchAllDocuments = () => Promise.reject(failure);
    mount("/database/tasks", src);
    await heading("tasks");
    const user = userEvent.setup();
    await user.click(within(grid("tasks")).getByRole("checkbox", { name: "Select all documents" }));
    await user.click(button("Edit all"));
    const panel = await screen.findByRole("complementary", { name: "Bulk edit all documents in tasks" });
    fireEvent.change(within(panel).getByRole("textbox"), { target: { value: "{ priority: 'high' }" } });
    await user.click(within(panel).getByRole("button", { name: "Apply" }));
    expect((await within(panel).findByRole("alert")).textContent).toBe(failure.message);
    expect((within(panel).getByRole("textbox") as HTMLTextAreaElement).value).toBe("{ priority: 'high' }");
    await expectAccessible();
    failure = new DataSourceError("unavailable", "the connection closed");
    await user.click(within(panel).getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(within(panel).getByRole("alert").textContent).toBe(
        "Could not bulk edit documents. Try editing fewer documents or use a migration.\n\nthe connection closed",
      ),
    );
    // closed and opened again, the draft is still there
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("complementary", { name: /^Bulk edit/ })).toBeNull());
    await user.click(button("Edit all"));
    const again = await screen.findByRole("complementary", { name: "Bulk edit all documents in tasks" });
    expect((within(again).getByRole("textbox") as HTMLTextAreaElement).value).toBe("{ priority: 'high' }");
  });

  test("Delete all opens the clear dialog (Convex's), its name typed to confirm", async () => {
    const { src } = source();
    mount("/database/tasks", src);
    await heading("tasks");
    const user = userEvent.setup();
    await user.click(within(grid("tasks")).getByRole("checkbox", { name: "Select all documents" }));
    await user.click(button("Delete all"));
    const dialog = await screen.findByRole("alertdialog", { name: "Clear tasks?" });
    await user.type(within(dialog).getByRole("textbox"), "tasks");
    await user.click(within(dialog).getByRole("button", { name: "Clear tasks" }));
    await screen.findByText("Cleared tasks: 250 documents deleted.");
    expect((await every(src, "tasks")).length).toBe(0);
  });

  test("read-only, or a source without the methods: no Edit", async () => {
    const ro = new MockDataSource({
      seed: 5,
      now: NOW,
      documents: { tasks: 250, users: 6, messages: 3, imports: 3 },
      capabilities: { operations: ["viewData"], readOnly: true },
    });
    mount("/database/tasks", ro);
    await heading("tasks");
    expect(screen.queryByRole("checkbox", { name: "Select all documents" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
  });
});

/** Opens another path in a fresh mount (the filter in the URL is read on mount). */
function cleanupAndMount(path: string, src: MockDataSource) {
  document.body.innerHTML = "";
  mount(path, src);
}
