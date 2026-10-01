// The Database screen's layout and its document panel following the row (UI-01 §22.3).
import { describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const source = () =>
  new MockDataSource({
    seed: 5,
    now: NOW,
    documents: { tasks: 20, users: 6, messages: 4, imports: 5 },
    executions: 10,
  });

function mount(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={source()} history={history} />);
  return { history };
}
const heading = (name: string) => screen.findByRole("heading", { level: 1, name });
const grid = () => screen.getByRole("grid", { name: "Documents in users" });
const rows = () => within(grid()).getAllByRole("row").slice(1);
const idOf = (row: HTMLElement) => within(row).getByRole("link").textContent!;
const cells = (row: HTMLElement) => within(row).getAllByRole("gridcell");
const docParam = (h: ReturnType<typeof createMemoryHistory>) => new URLSearchParams(h.location.search).get("doc");

describe("the document panel follows the row", () => {
  test("a click on any cell of another row opens that row's document; ↑/↓ follow too", async () => {
    const first = (
      await (
        await source()
      ).listDocuments({ table: "users", numItems: 1, cursor: null, filter: { clauses: [], order: "desc" } })
    ).page[0]!;
    const { history } = mount(`/database/users?doc=${first._id}`);
    await heading("users");
    await screen.findByRole("complementary", { name: first._id });
    await waitFor(() => expect(rows().length).toBeGreaterThan(3));
    const user = userEvent.setup();
    const third = rows()[2]!;
    // a plain cell (not the _id link) of the third row
    await user.click(cells(third)[3]!);
    await waitFor(() => expect(docParam(history)).toBe(idOf(third)));
    await screen.findByRole("complementary", { name: idOf(third) });
    // the grid keeps the focus, and the arrows move the panel along
    await user.keyboard("{ArrowDown}");
    const fourth = rows()[3]!;
    await waitFor(() => expect(docParam(history)).toBe(idOf(fourth)));
    await screen.findByRole("complementary", { name: idOf(fourth) });
    await user.keyboard("{ArrowUp}{ArrowUp}");
    await waitFor(() => expect(docParam(history)).toBe(idOf(rows()[1]!)));
    // moving within the same row changes nothing
    await user.keyboard("{ArrowRight}");
    expect(docParam(history)).toBe(idOf(rows()[1]!));
  });

  test("with no document open, clicking a cell opens nothing", async () => {
    const { history } = mount("/database/users");
    await heading("users");
    await waitFor(() => expect(rows().length).toBeGreaterThan(3));
    await userEvent.setup().click(cells(rows()[1]!)[3]!);
    expect(docParam(history)).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  test("an edit with unsaved changes holds the panel: the editor stays, a notice says why", async () => {
    const { history } = mount("/database/users");
    await heading("users");
    await waitFor(() => expect(rows().length).toBeGreaterThan(3));
    const user = userEvent.setup();
    const firstId = idOf(rows()[0]!);
    await user.click(within(rows()[0]!).getByRole("link"));
    const panel = await screen.findByRole("complementary", { name: firstId });
    await user.click(await within(panel).findByRole("button", { name: "Edit" }));
    const editor = within(panel).getByRole("textbox", { name: `Fields of ${firstId}` });
    // opening the editor without changing anything does not hold the panel
    fireEvent.change(editor, { target: { value: "{ name: 'Changed' }" } });
    await user.click(cells(rows()[2]!)[3]!);
    expect((await screen.findByRole("alert")).textContent).toBe("Save or cancel your edit to open another document.");
    expect(docParam(history)).toBe(firstId);
    expect(within(screen.getByRole("complementary", { name: firstId })).getByRole("textbox")).toBeDefined();
    // cancelled, the panel follows again
    await user.click(within(panel).getByRole("button", { name: "Cancel" }));
    await user.click(cells(rows()[2]!)[3]!);
    await waitFor(() => expect(docParam(history)).toBe(idOf(rows()[2]!)));
  });

  test("an unchanged editor does not hold the panel", async () => {
    const { history } = mount("/database/users");
    await heading("users");
    await waitFor(() => expect(rows().length).toBeGreaterThan(3));
    const user = userEvent.setup();
    await user.click(within(rows()[0]!).getByRole("link"));
    const panel = await screen.findByRole("complementary");
    await user.click(await within(panel).findByRole("button", { name: "Edit" }));
    await user.click(cells(rows()[1]!)[3]!);
    await waitFor(() => expect(docParam(history)).toBe(idOf(rows()[1]!)));
  });
});

describe("the Database layout", () => {
  test("two bars across the top — the table with its actions, the filters — then the grid filling the rest", async () => {
    mount("/database/users");
    const h1 = await heading("users");
    const bar1 = h1.parentElement!;
    expect(bar1.className).toMatch(/\bmin-h-11\b/);
    expect(bar1.className).toMatch(/\bborder-b\b/);
    expect(within(bar1).getByRole("button", { name: /Add documents/ })).toBeDefined();
    const filters = screen.getByRole("region", { name: "Filters" });
    expect(filters.className).toMatch(/\bborder-b\b/);
    expect(filters.className).not.toMatch(/\bbg-card\b/);
    // Index, the range and Add filter on one row
    const firstRow = filters.firstElementChild as HTMLElement;
    expect(within(firstRow).getByRole("button", { name: "Add filter" })).toBeDefined();
    expect(within(firstRow).getByText("Index")).toBeDefined();
    // the grid fills its column: no frame, no height cap, the footer pinned at its bottom
    const region = document.querySelector<HTMLElement>('[data-slot="data-table"]')!;
    expect(region.className).toMatch(/\bflex-1\b/);
    expect(region.className).not.toMatch(/max-h-/);
    expect(region.querySelector('[data-slot="data-table-footer"]')!.className).toMatch(/\bsticky\b.*\bbottom-0\b/);
    await expectAccessible();
  });
});
