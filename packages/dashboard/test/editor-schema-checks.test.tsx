// The Data screen's editors check what is typed against the table's declared type (STUDY-163 §3), as Convex's
// object editor: a misfit is an error that blocks saving when the schema is enforced, a warning that does not when
// it is not. The add-documents panel, the document editor and the cell editor; the checks' model.
import { describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SchemaInfo, ValidatorJson, Value } from "../src/data-source.ts";
import { cellIssues } from "../src/database/cell-editor.tsx";
import { parseLiteralLocated } from "../src/database/literal.ts";
import { fieldSchema, issueDisplay, schemaIssues, tableSchema } from "../src/database/schema-check.ts";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const source = (schemaEnforced: boolean) =>
  new MockDataSource({
    seed: 5,
    now: NOW,
    documents: { tasks: 10, users: 6, messages: 3, imports: 3 },
    executions: 5,
    schemaEnforced,
  });
function mount(path: string, src: MockDataSource) {
  render(<Dashboard dataSource={src} history={createMemoryHistory({ initialEntries: [path] })} />);
  return src;
}

const str: ValidatorJson = { type: "string" };
const USERS: ValidatorJson = {
  type: "object",
  value: {
    name: { fieldType: str, optional: false },
    nick: { fieldType: str, optional: true },
  },
};
const schema = (enforced: boolean): SchemaInfo => ({ enforced, tables: [{ name: "users", validator: USERS }] });

describe("the checks' model", () => {
  test("a table's declared type and a field's, with whether it may be left out", () => {
    expect(tableSchema(schema(true), "users")).toEqual({ validator: USERS, enforced: true });
    expect(tableSchema(schema(true), "other")).toBeNull();
    expect(tableSchema(undefined, "users")).toBeNull();
    expect(fieldSchema(tableSchema(schema(false), "users"), "nick")).toEqual({
      validator: str,
      optional: true,
      enforced: false,
    });
    expect(fieldSchema(tableSchema(schema(false), "users"), "nope")).toBeNull();
  });

  test("each misfit at its place: a value of another type, a key not declared, a missing field", () => {
    const text = '{ name: 1, extra: "x" }';
    const r = parseLiteralLocated(text);
    if (!r.ok) throw new Error(r.error);
    const issues = schemaIssues(USERS, r.value as Value, r.place);
    expect(issues.map((i) => text.slice(i.offset, i.offset + 5))).toEqual(["1, ex", "extra"]);
    expect(issues[0]!.message).toBe("name: Type 'number' is not assignable to v.string()");
    const missing = parseLiteralLocated("[{ name: 'a' }, {}]");
    if (!missing.ok) throw new Error(missing.error);
    const list = (missing.value as never[]).flatMap((d, i) => schemaIssues(USERS, d, missing.place, [i]));
    expect(list.map((i) => i.message)).toEqual(["Document 2: Property 'name' is missing but required: v.string()"]);
  });

  test("a cell: emptied or undefined while required; any value fits an undeclared field", () => {
    const name = fieldSchema(tableSchema(schema(true), "users"), "name");
    const nick = fieldSchema(tableSchema(schema(true), "users"), "nick");
    expect(cellIssues("", name).map((i) => i.message)).toEqual(["Value is missing but required: v.string()"]);
    expect(cellIssues("undefined", name)).toHaveLength(1);
    expect(cellIssues("", nick)).toEqual([]);
    expect(cellIssues("3", name).map((i) => i.message)).toEqual(["Type 'number' is not assignable to v.string()"]);
    expect(cellIssues('"ok"', name)).toEqual([]);
    expect(cellIssues("{ not a literal", name)).toEqual([]);
    expect(cellIssues("3", null)).toEqual([]);
  });

  test("enforced: the first is the error and blocks; not enforced: warnings and a note", () => {
    const issues = [
      { message: "a", offset: 0 },
      { message: "b", offset: 3 },
    ];
    expect(issueDisplay(issues, true)).toMatchObject({ error: issues[0], moreErrors: [issues[1]] });
    const loose = issueDisplay(issues, false);
    expect(loose.error).toBeUndefined();
    expect(loose.warnings).toEqual(issues);
    expect(loose.note).toBe("2 values do not match the schema, which is not enforced: a");
    expect(issueDisplay([], true).error).toBeUndefined();
  });
});

describe("add documents", () => {
  test("enforced: a document that does not fit is said, and cannot be added", async () => {
    const src = mount("/database/users?panel=add", source(true));
    const panel = await screen.findByRole("complementary", { name: "Add documents to users" });
    const editor = within(panel).getByRole("textbox", { name: "Documents" });
    fireEvent.change(editor, { target: { value: '{ name: 1, email: "a@b", admin: true, credits: 1n }' } });
    expect(
      await within(panel).findByText("name: Type 'number' is not assignable to v.string()", { exact: false }),
    ).toBeDefined();
    expect(within(panel).getByRole("button", { name: "Add document" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(editor, { target: { value: '{ name: "Ada", email: "a@b", admin: true, credits: 1n }' } });
    await waitFor(() =>
      expect(within(panel).getByRole("button", { name: "Add document" }).hasAttribute("disabled")).toBe(false),
    );
    const before = (await src.listTables()).find((t) => t.name === "users")!.documentCount;
    await userEvent.setup().click(within(panel).getByRole("button", { name: "Add document" }));
    await waitFor(async () =>
      expect((await src.listTables()).find((t) => t.name === "users")!.documentCount).toBe(before! + 1),
    );
  });

  test("not enforced: a warning, and the document can still be added", async () => {
    const src = mount("/database/users?panel=add", source(false));
    const panel = await screen.findByRole("complementary", { name: "Add documents to users" });
    fireEvent.change(within(panel).getByRole("textbox", { name: "Documents" }), { target: { value: "{ name: 1 }" } });
    expect(
      await within(panel).findByText("not match the schema, which is not enforced", { exact: false }),
    ).toBeDefined();
    await expectAccessible(panel);
    const before = (await src.listTables()).find((t) => t.name === "users")!.documentCount;
    await userEvent.setup().click(within(panel).getByRole("button", { name: "Add document" }));
    await waitFor(async () =>
      expect((await src.listTables()).find((t) => t.name === "users")!.documentCount).toBe(before! + 1),
    );
  });
});

describe("edit a document", () => {
  test("enforced: a field of another type blocks Save, with the reason", async () => {
    const src = source(true);
    const [doc] = (await src.listDocuments({ table: "users", numItems: 1, cursor: null })).page;
    mount(`/database/users?doc=${doc!._id}`, src);
    const panel = await screen.findByRole("complementary", { name: new RegExp(doc!._id) });
    await userEvent.setup().click(await within(panel).findByRole("button", { name: "Edit" }));
    const editor = within(panel).getByRole("textbox", { name: `Fields of ${doc!._id}` });
    fireEvent.change(editor, { target: { value: '{ name: "G", email: "g@h", admin: "yes", credits: 1n }' } });
    expect(
      await within(panel).findByText("admin: Type 'string' is not assignable to v.boolean()", { exact: false }),
    ).toBeDefined();
    expect(within(panel).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("edit a cell", () => {
  test("enforced: a value of another type is said as it is typed, and Enter does not save it", async () => {
    const src = mount("/database/users", source(true));
    await screen.findByRole("heading", { level: 1, name: "users" });
    const user = userEvent.setup();
    const grid = screen.getByRole("grid", { name: "Documents in users" });
    const header = within(grid).getAllByRole("columnheader");
    const col = header.findIndex((h) => h.textContent === "name");
    const row = within(grid).getAllByRole("row")[1]!;
    const id = within(row).getByRole("link").textContent!;
    const cell = within(row).getAllByRole("gridcell")[col]!;
    await user.click(cell);
    await waitFor(() => expect(document.activeElement).toBe(cell));
    await user.keyboard("{Enter}");
    const input = screen.getByRole("textbox", { name: "Edit name" });
    await user.clear(input);
    await user.type(input, "42");
    expect(await screen.findByText("Type 'number' is not assignable to v.string()")).toBeDefined();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("textbox", { name: "Edit name" })).toBeDefined();
    expect(typeof (await src.getDocument("users", id))?.name).toBe("string");
  });
});
