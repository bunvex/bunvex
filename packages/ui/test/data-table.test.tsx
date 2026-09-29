import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { DataTable, dataTableColumns } from "@bunvex/ui/components/data-table";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expectAccessible } from "./axe.ts";

type Row = { id: string; name: string; n: number };
const rows = (count: number): Row[] =>
  Array.from({ length: count }, (_, i) => ({ id: `r${i}`, name: `row ${i}`, n: i }));
const col = dataTableColumns<Row>();
const columns = col.columns([
  col.accessor("name", { header: "Name" }),
  col.accessor("n", { header: "Number", cell: (c) => <span className="tabular-nums">{c.getValue()}</span> }),
]);

// happy-dom has no layout, so every offsetHeight is 0 and the virtualizer would render no row: give the
// table's scroll container the size a browser would (360 × 800 px), for this file only.
const VIEWPORT = { offsetHeight: 360, offsetWidth: 800 };
const saved = Object.keys(VIEWPORT).map((k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)] as const);
beforeAll(() => {
  for (const [key, size] of Object.entries(VIEWPORT)) {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)?.get;
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.slot === "data-table" ? size : (original?.call(this) ?? 0);
      },
    });
  }
});
afterAll(() => {
  for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
});

describe("DataTable", () => {
  test("is a labelled table with headers, rendering only the rows in view", async () => {
    render(<DataTable label="Tasks" columns={columns} data={rows(1000)} getRowId={(r) => r.id} initialHeight={360} />);
    const table = screen.getByRole("table", { name: "Tasks" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Name", "Number"]);
    const bodyRows = within(table).getAllByRole("row").slice(1);
    expect(bodyRows.length).toBeGreaterThan(5);
    expect(bodyRows.length).toBeLessThan(40); // 360 px / 36 px + overscan, not 1 000
    expect(table.getAttribute("aria-rowcount")).toBe("1001");
    expect(bodyRows[0]!.getAttribute("aria-rowindex")).toBe("2");
    expect(screen.getByText("row 0")).toBeDefined();
    expect(screen.queryByText("row 999")).toBeNull();
    await expectAccessible();
  });

  test("asks for more near the end, not before", () => {
    const onEnd = mock(() => {});
    const { rerender } = render(
      <DataTable label="t" columns={columns} data={rows(200)} onEndReached={onEnd} initialHeight={360} />,
    );
    expect(onEnd).not.toHaveBeenCalled();
    rerender(<DataTable label="t" columns={columns} data={rows(12)} onEndReached={onEnd} initialHeight={360} />);
    expect(onEnd).toHaveBeenCalled();
  });

  test("rows can be activated by click or Enter", async () => {
    const onActivate = mock((_: Row) => {});
    render(<DataTable label="t" columns={columns} data={rows(3)} onRowActivate={onActivate} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("row 1"));
    expect(onActivate).toHaveBeenLastCalledWith({ id: "r1", name: "row 1", n: 1 });
    screen.getByText("row 2").closest("tr")!.focus();
    await user.keyboard("{Enter}");
    expect(onActivate).toHaveBeenLastCalledWith({ id: "r2", name: "row 2", n: 2 });
  });

  test("an empty table says so", () => {
    render(<DataTable label="t" columns={columns} data={[]} empty="No documents in this table yet." />);
    expect(screen.getByText("No documents in this table yet.")).toBeDefined();
  });
});
