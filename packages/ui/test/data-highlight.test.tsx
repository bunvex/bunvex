import { describe, expect, test } from "bun:test";
import { DataTable, dataTableColumns, type HighlightOptions } from "@bunvex/ui/components/data-table";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

type Row = { id: string; name: string; n: number };
const rows = (count: number, prefix = "r"): Row[] =>
  Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, name: `row ${i}`, n: i }));
const col = dataTableColumns<Row>();
const columns = col.columns([col.accessor("name", { header: "Name" }), col.accessor("n", { header: "Number" })]);

const view = (data: Row[], opts: { highlight?: boolean | HighlightOptions; resetKey?: string } = {}) => (
  <DataTable
    label="Rows"
    columns={columns}
    data={data}
    getRowId={(r) => r.id}
    grid={{}}
    resetKey={opts.resetKey}
    highlightChanges={opts.highlight ?? { durationMs: 40 }}
  />
);
const changedCells = () => [...document.querySelectorAll("td[data-changed]")].map((td) => td.textContent);
const addedRows = () => [...document.querySelectorAll("tr[data-added]")].map((tr) => tr.firstElementChild?.textContent);

describe("DataTable: what changed", () => {
  test("nothing is marked on the first render; a changed value marks its cell, then the mark goes", async () => {
    const data = rows(5);
    const { rerender } = render(view(data));
    expect(changedCells()).toEqual([]);
    rerender(view(data.map((r) => (r.id === "r2" ? { ...r, name: "renamed" } : r))));
    expect(changedCells()).toEqual(["renamed"]);
    const cell = screen.getByText("renamed").closest("td")!;
    expect(cell.className).toContain("animate-highlight");
    expect(cell.className).toContain("motion-reduce:bg-highlight"); // still visible with reduced motion
    await waitFor(() => expect(changedCells()).toEqual([]));
  });

  test("a row inserted above is added; rows appended at the end (the next page) are not", () => {
    const data = rows(5);
    const { rerender } = render(view(data));
    rerender(view([...rows(1, "new"), ...data, ...rows(3, "page2-")]));
    expect(addedRows()).toEqual(["row 0"]); // the new row's name (prefix "new", index 0)
    expect(document.querySelector("tr[data-added] td")?.textContent).toBe("row 0");
    expect(document.querySelectorAll("tr[data-added]")).toHaveLength(1);
  });

  test("a new list (resetKey) is not compared with the old one", () => {
    const { rerender } = render(view(rows(5), { resetKey: "a" }));
    rerender(
      view(
        rows(5).map((r) => ({ ...r, n: r.n + 100 })),
        { resetKey: "b" },
      ),
    );
    expect(changedCells()).toEqual([]);
  });

  test("rows arriving above a scrolled view flash the header's edge", async () => {
    const data = rows(300);
    const { rerender, container } = render(view(data));
    const scroller = container.querySelector<HTMLElement>("[data-slot=data-table]")!;
    scroller.scrollTop = 36 * 100;
    fireEvent.scroll(scroller);
    rerender(view([...rows(3, "new"), ...data]));
    expect(container.querySelector("thead tr")?.getAttribute("data-new-above")).toBe("true");
    await waitFor(() => expect(container.querySelector("thead tr")?.hasAttribute("data-new-above")).toBe(false));
  });

  test("changes are announced to screen readers, at most once every 5 s", async () => {
    const announce = ({ changed, added }: { changed: number; added: number }) => `${changed} changed, ${added} added`;
    const data = rows(5);
    const { rerender } = render(view(data, { highlight: { durationMs: 40, announce } }));
    const status = screen.getByRole("status");
    rerender(
      view(
        data.map((r) => (r.id === "r1" ? { ...r, n: 99 } : r)),
        { highlight: { durationMs: 40, announce } },
      ),
    );
    expect(status.textContent).toBe("1 changed, 0 added");
    // a second batch right away waits for its turn
    rerender(
      view([...rows(1, "new"), ...data.map((r) => (r.id === "r1" ? { ...r, n: 99 } : r))], {
        highlight: { durationMs: 40, announce },
      }),
    );
    expect(status.textContent).toBe("1 changed, 0 added");
  });

  test("without highlightChanges, nothing is marked and nothing is announced", () => {
    const data = rows(3);
    const { rerender } = render(<DataTable label="Rows" columns={columns} data={data} getRowId={(r) => r.id} />);
    rerender(
      <DataTable label="Rows" columns={columns} data={data.map((r) => ({ ...r, n: 7 }))} getRowId={(r) => r.id} />,
    );
    expect(changedCells()).toEqual([]);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
