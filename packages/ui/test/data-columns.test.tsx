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

  test("dragging a header moves the column (a bar marks where), and is saved; Escape cancels", () => {
    // happy-dom has no layout: each header is 100 px wide, side by side
    const real = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.tagName !== "TH") return real.call(this);
      const i = [...this.parentElement!.children].indexOf(this);
      return { left: i * 100, right: i * 100 + 100, width: 100, top: 0, bottom: 36, height: 36 } as DOMRect;
    };
    try {
      render(<Persisted />);
      const [a, , c] = screen.getAllByRole("columnheader");
      // a press that barely moves is not a drag
      fireEvent.pointerDown(c!, { button: 0, clientX: 250, pointerId: 1 });
      fireEvent.pointerMove(c!, { clientX: 252, pointerId: 1 });
      expect(c!.hasAttribute("data-dragging")).toBe(false);
      fireEvent.pointerUp(c!, { pointerId: 1 });
      expect(headers()).toEqual(["a", "b", "c"]);
      // c onto the left half of a: before a, with the bar on a's left edge while dragging
      fireEvent.pointerDown(c!, { button: 0, clientX: 250, pointerId: 1 });
      fireEvent.pointerMove(c!, { clientX: 30, pointerId: 1 });
      expect(a!.getAttribute("data-drop")).toBe("before");
      expect(c!.hasAttribute("data-dragging")).toBe(true);
      fireEvent.pointerUp(c!, { pointerId: 1 });
      expect(headers()).toEqual(["c", "a", "b"]);
      expect(state().order).toEqual(["c", "a", "b"]);
      // to the end: past the last header's middle
      const [c2] = screen.getAllByRole("columnheader");
      fireEvent.pointerDown(c2!, { button: 0, clientX: 50, pointerId: 1 });
      fireEvent.pointerMove(c2!, { clientX: 290, pointerId: 1 });
      expect(screen.getAllByRole("columnheader")[2]!.getAttribute("data-drop")).toBe("after");
      fireEvent.keyDown(window, { key: "Escape" });
      fireEvent.pointerUp(c2!, { pointerId: 1 });
      expect(headers()).toEqual(["c", "a", "b"]);
      // the resize handle keeps its own drag
      const handle = within(screen.getAllByRole("columnheader")[1]!).getByRole("separator");
      fireEvent.pointerDown(handle, { button: 0, clientX: 190, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientX: 20, pointerId: 1 });
      fireEvent.pointerUp(handle, { pointerId: 1 });
      expect(headers()).toEqual(["c", "a", "b"]);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = real;
    }
  });

  test("without onColumnStateChange there are no handles", () => {
    render(<DataTable label="Rows" columns={columns} data={data} getRowId={(r) => r.id} />);
    expect(screen.queryByRole("separator")).toBeNull();
  });
});
