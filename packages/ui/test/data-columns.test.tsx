import { describe, expect, test } from "bun:test";
import { DataTable, dataTableColumns } from "@bunvex/ui/components/data-table";
import type { ColumnState } from "@bunvex/ui/lib/column-state";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expectAccessible } from "./axe.ts";

type Row = { id: string; a: string; b: string; c: string };
const data: Row[] = [{ id: "r0", a: "A", b: "B", c: "C" }];
const col = dataTableColumns<Row>();
const columns = col.columns([
  col.accessor("a", { header: "a" }),
  col.accessor("b", { header: "b" }),
  col.accessor("c", { header: "c" }),
]);

function Persisted({ initial = {} }: { initial?: ColumnState }) {
  const [state, setState] = useState<ColumnState>(initial);
  return (
    <>
      <DataTable
        label="Rows"
        columns={columns}
        data={data}
        getRowId={(r) => r.id}
        grid={{}}
        columnState={state}
        onColumnStateChange={setState}
      />
      <output aria-label="state">{JSON.stringify(state)}</output>
    </>
  );
}
const headers = () => screen.getAllByRole("columnheader").map((h) => h.textContent);
const state = () => JSON.parse(screen.getByLabelText("state").textContent!) as ColumnState;
const widthOf = (i: number) => (document.querySelectorAll("colgroup col")[i] as HTMLElement).style.width;

describe("DataTable columns", () => {
  test("the saved order and hidden columns are applied", () => {
    render(<Persisted initial={{ order: ["c", "a", "b"], hidden: ["a"] }} />);
    expect(headers()).toEqual(["c", "b"]);
    expect(
      within(screen.getByRole("row", { name: /C/ }))
        .getAllByRole("gridcell")
        .map((c) => c.textContent),
    ).toEqual(["C", "B"]);
  });

  test("a resize handle per header: arrows resize (Shift for more), Enter resets", async () => {
    render(<Persisted />);
    const handle = screen.getByRole("separator", { name: "Resize b" });
    expect(handle.getAttribute("aria-valuenow")).toBe("180");
    handle.focus();
    const user = userEvent.setup();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(state().widths).toEqual({ b: 212 });
    expect(widthOf(1)).toBe("212px");
    await user.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    expect(state().widths).toEqual({ b: 148 });
    await user.keyboard("{Enter}");
    expect(state().widths).toEqual({});
    await expectAccessible();
  });

  test("dragging a handle resizes live and saves on release; widths are clamped", () => {
    render(<Persisted />);
    const handle = screen.getByRole("separator", { name: "Resize a" });
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 150, pointerId: 1 });
    expect(widthOf(0)).toBe("230px");
    expect(state().widths).toBeUndefined(); // not saved while dragging
    fireEvent.pointerUp(handle, { clientX: 2000, pointerId: 1 });
    expect(state().widths).toEqual({ a: 800 });
    fireEvent.doubleClick(handle);
    expect(state().widths).toEqual({});
  });

  test("without onColumnStateChange there are no handles", () => {
    render(<DataTable label="Rows" columns={columns} data={data} getRowId={(r) => r.id} />);
    expect(screen.queryByRole("separator")).toBeNull();
  });
});
