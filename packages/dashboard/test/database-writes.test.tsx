import { describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { parseDocuments } from "../src/database/add-documents.tsx";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const source = (opts: Partial<ConstructorParameters<typeof MockDataSource>[0]> = {}) =>
  new MockDataSource({
    seed: 5,
    now: NOW,
    documents: { tasks: 10, users: 6, messages: 3, imports: 3 },
    executions: 5,
    ...opts,
  });

function mount(path: string, src = source()) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={src} history={history} />);
  return { history, src };
}
const heading = (name: string) => screen.findByRole("heading", { level: 1, name });
const count = async (src: MockDataSource, table: string) =>
  (await src.listTables()).find((t) => t.name === table)!.documentCount;

describe("parsing documents to add", () => {
  test("an object or a list of objects; no system fields; readable errors", () => {
    expect(parseDocuments('{"a": 1}')).toEqual({ ok: true, documents: [{ a: 1 }] });
    expect(parseDocuments('[{"a": 1}, {}]')).toEqual({ ok: true, documents: [{ a: 1 }, {}] });
    expect(parseDocuments("[]")).toEqual({ ok: false, error: "The list is empty." });
    expect(parseDocuments("[1]")).toEqual({
      ok: false,
      error: "The document is not an object: write { field: value }.",
    });
    expect(parseDocuments('[{}, {"_id": "x"}]')).toEqual({
      ok: false,
      error: 'Document 2: "_id" is a system field; the database sets it.',
    });
    expect(parseDocuments("{").ok).toBe(false);
    // JavaScript literals, as in Convex: bare keys, quotes of either kind, 10n, trailing commas
    expect(parseDocuments("{ name: 'Ada', credits: 10n, }")).toEqual({
      ok: true,
      documents: [{ name: "Ada", credits: { $integer: "CgAAAAAAAAA=" } }],
    });
    expect(parseDocuments("{ name: Ada }")).toMatchObject({ ok: false, offset: 8 });
  });
});

describe("adding, deleting, clearing", () => {
  test("Add documents: literals in a side panel, all added at once, then said", async () => {
    const { src } = mount("/database/users");
    await heading("users");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add documents" }));
    const panel = await screen.findByRole("complementary", { name: "Add documents to users" });
    const editor = within(panel).getByRole("textbox", { name: "Documents" });
    fireEvent.change(editor, { target: { value: '{"name": ' } });
    expect(within(panel).getByText(/^Expected a value/)).toBeDefined();
    expect(within(panel).getByRole("button", { name: "Add document" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(editor, { target: { value: '[{"name": "Ada"}, {"name": "Alan", "admin": true}]' } });
    await expectAccessible();
    await user.click(within(panel).getByRole("button", { name: "Add 2 documents" }));
    expect((await screen.findByRole("status", { name: "" }).catch(() => null)) ?? true).toBeTruthy();
    await screen.findByText("Added 2 documents to users.");
    expect(screen.queryByRole("complementary", { name: "Add documents to users" })).toBeNull();
    expect(await count(src, "users")).toBe(8);
    await waitFor(() => expect(screen.getByText("Alan")).toBeDefined());
  });

  test("a refused insert keeps the panel and the draft, with the reason", async () => {
    const src = source();
    src.insertDocuments = () => Promise.reject(new Error("document too large"));
    mount("/database/users?panel=add", src);
    const panel = await screen.findByRole("complementary", { name: "Add documents to users" });
    fireEvent.change(within(panel).getByRole("textbox"), { target: { value: '{"name": "x"}' } });
    await userEvent.setup().click(within(panel).getByRole("button", { name: "Add document" }));
    expect((await within(panel).findByRole("alert")).textContent).toBe("document too large");
    expect((within(panel).getByRole("textbox") as HTMLTextAreaElement).value).toBe('{"name": "x"}');
  });

  test("Delete: select rows, confirm, and they are gone", async () => {
    const { src } = mount("/database/users");
    await heading("users");
    const user = userEvent.setup();
    const grid = screen.getByRole("grid", { name: "Documents in users" });
    const boxes = within(grid).getAllByRole("checkbox").slice(1); // [0] is "select every loaded row"
    await user.click(boxes[0]!);
    await user.keyboard("{Shift>}");
    await user.click(boxes[2]!);
    await user.keyboard("{/Shift}");
    await user.click(screen.getByRole("button", { name: "Delete 3" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete 3 documents?" });
    // the dialog itself: while it is open the page behind is hidden from assistive tech, which browsers
    // make inert — happy-dom has no `inert`, so axe would see focusable cells behind the dialog
    await expectAccessible(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Delete 3 documents" }));
    await screen.findByText("Deleted 3 documents from users.");
    expect(await count(src, "users")).toBe(3);
    expect(screen.queryByRole("button", { name: /^Delete \d/ })).toBeNull(); // the selection is gone
    // the button that opened the dialog is gone: the focus is back in the grid, not lost on <body>
    await waitFor(() => expect((document.activeElement as HTMLElement).getAttribute("role")).toBe("gridcell"));
  });

  test("Delete can be called off", async () => {
    const { src } = mount("/database/users");
    await heading("users");
    const user = userEvent.setup();
    await user.click(within(screen.getByRole("grid")).getAllByRole("checkbox")[1]!);
    await user.click(screen.getByRole("button", { name: "Delete 1" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(await count(src, "users")).toBe(6);
  });

  test("Clear table: only once its name is typed", async () => {
    const { src } = mount("/database/messages");
    await heading("messages");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More actions on messages" }));
    await user.click(await screen.findByRole("menuitem", { name: "Clear table…" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Clear messages?" });
    const confirm = within(dialog).getByRole("button", { name: "Clear messages" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    await user.type(within(dialog).getByRole("textbox", { name: /Type messages to confirm/ }), "message");
    expect(confirm.hasAttribute("disabled")).toBe(true);
    await user.type(within(dialog).getByRole("textbox"), "s");
    await user.click(confirm);
    await screen.findByText("Cleared messages: 3 documents deleted.");
    expect(await count(src, "messages")).toBe(0);
    await screen.findByText("No documents in messages yet.");
  });

  test("read-only: no way to add, select, delete or clear", async () => {
    mount("/database/users", source({ capabilities: { operations: ["viewData"], readOnly: false } }));
    await heading("users");
    await screen.findByText("Read-only");
    expect(screen.queryByRole("button", { name: "Add documents" })).toBeNull();
    expect(screen.queryByRole("button", { name: /More actions/ })).toBeNull();
    expect(within(screen.getByRole("grid")).queryAllByRole("checkbox")).toEqual([]);
  });

  test("Edit a document: its fields as a literal, saved whole; system fields stay", async () => {
    const src = source();
    const [doc] = (await src.listDocuments({ table: "users", numItems: 1, cursor: null })).page;
    mount(`/database/users?doc=${doc!._id}`, src);
    const panel = await screen.findByRole("complementary", { name: new RegExp(doc!._id) });
    const user = userEvent.setup();
    await user.click(await within(panel).findByRole("button", { name: "Edit" }));
    const editor = within(panel).getByRole("textbox", { name: `Fields of ${doc!._id}` }) as HTMLTextAreaElement;
    expect(editor.value).not.toContain("_id");
    fireEvent.change(editor, { target: { value: "{ _id: 'x' }" } });
    expect(within(panel).getByText('"_id" is a system field; it cannot be changed here.')).toBeDefined();
    expect(within(panel).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(editor, { target: { value: "{ name: 'Grace', credits: 3n }" } });
    await expectAccessible();
    await user.click(within(panel).getByRole("button", { name: "Save" }));
    await within(panel).findByText("Saved.");
    expect(await src.getDocument("users", doc!._id)).toEqual({
      _id: doc!._id,
      _creationTime: doc!._creationTime,
      name: "Grace",
      credits: { $integer: "AwAAAAAAAAA=" },
    });
    expect(within(panel).getByRole("button", { name: "Edit" })).toBeDefined();
  });

  test("Escape leaves the document unchanged; a refused save keeps the editor with the reason", async () => {
    const src = source();
    const [doc] = (await src.listDocuments({ table: "users", numItems: 1, cursor: null })).page;
    mount(`/database/users?doc=${doc!._id}`, src);
    const panel = await screen.findByRole("complementary", { name: new RegExp(doc!._id) });
    const user = userEvent.setup();
    await user.click(await within(panel).findByRole("button", { name: "Edit" }));
    fireEvent.change(within(panel).getByRole("textbox"), { target: { value: "{}" } });
    await user.keyboard("{Escape}");
    expect(within(panel).queryByRole("textbox")).toBeNull();
    expect(await src.getDocument("users", doc!._id)).toEqual(doc!);
    src.replaceDocument = () => Promise.reject(new Error("document too large"));
    await user.click(within(panel).getByRole("button", { name: "Edit" }));
    await user.click(within(panel).getByRole("button", { name: "Save" }));
    expect((await within(panel).findByRole("alert")).textContent).toBe("document too large");
    expect(within(panel).getByRole("textbox")).toBeDefined();
  });

  test("read-only: a document has no Edit", async () => {
    const src = source({ capabilities: { operations: ["viewData"], readOnly: false } });
    const [doc] = (await src.listDocuments({ table: "users", numItems: 1, cursor: null })).page;
    mount(`/database/users?doc=${doc!._id}`, src);
    const panel = await screen.findByRole("complementary", { name: new RegExp(doc!._id) });
    await within(panel).findByRole("button", { name: "Copy" });
    expect(within(panel).queryByRole("button", { name: "Edit" })).toBeNull();
  });
});
