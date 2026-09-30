import { describe, expect, mock, test } from "bun:test";
import { DataTable, dataTableColumns, type EditOutcome } from "@bunvex/ui/components/data-table";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expectAccessible } from "./axe.ts";

type Row = { id: string; name: string; n: number };
const rows = (count: number, prefix = "r"): Row[] =>
  Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, name: `row ${i}`, n: i }));
const col = dataTableColumns<Row>();
const columns = col.columns([
  col.accessor("id", { header: "Id" }),
  col.accessor("name", { header: "Name" }),
  col.accessor("n", { header: "Number" }),
]);

/** A grid whose Name cells are editable with a plain input: Enter saves, Tab saves and moves, Esc cancels. */
function Editable({ initial, onSave }: { initial: Row[]; onSave?: (id: string, name: string) => void }) {
  const [data, setData] = useState(initial);
  const [activated, setActivated] = useState("");
  return (
    <>
      <DataTable
        label="Rows"
        columns={columns}
        data={data}
        getRowId={(r) => r.id}
        grid={{
          canEdit: (_, c) => c === "name",
          onCellActivate: (r, c) => setActivated(`${r.id}:${c}`),
          renderEditor: ({ row, done }) => (
            <input
              aria-label="Edit name"
              // biome-ignore lint/a11y/noAutofocus: the editor takes the focus when it opens, as in a spreadsheet
              autoFocus
              defaultValue={row.name}
              onKeyDown={(e) => {
                const save = (outcome: EditOutcome) => {
                  const name = e.currentTarget.value;
                  setData((d) => d.map((x) => (x.id === row.id ? { ...x, name } : x)));
                  onSave?.(row.id, name);
                  done(outcome);
                };
                if (e.key === "Enter") save("stay");
                else if (e.key === "Tab") {
                  e.preventDefault();
                  save("right");
                } else if (e.key === "Escape") done("cancel");
              }}
            />
          ),
        }}
      />
      <output aria-label="activated">{activated}</output>
    </>
  );
}

const cellText = () => (document.activeElement as HTMLElement).textContent;

describe("DataTable as a grid", () => {
  test("one cell is in the tab order; arrows, Home/End and Ctrl+End move between cells", async () => {
    render(<Editable initial={rows(50)} />);
    const grid = screen.getByRole("grid", { name: "Rows" });
    expect(
      within(grid)
        .getAllByRole("gridcell")
        .filter((c) => c.tabIndex === 0),
    ).toHaveLength(1);
    const user = userEvent.setup();
    await user.tab();
    expect(cellText()).toBe("r0");
    await user.keyboard("{ArrowRight}");
    expect(cellText()).toBe("row 0");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(cellText()).toBe("row 2");
    await user.keyboard("{End}");
    expect(cellText()).toBe("2");
    await user.keyboard("{Home}");
    expect(cellText()).toBe("r2");
    await user.keyboard("{ArrowLeft}{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(cellText()).toBe("r0"); // clamped at the edges
    await user.keyboard("{Control>}{End}{/Control}");
    expect(cellText()).toBe("49"); // the last cell, scrolled into the view
    await user.keyboard("{Control>}{Home}{/Control}");
    expect(cellText()).toBe("r0");
    await expectAccessible();
  });

  test("PageDown moves a screenful; moving past the rendered rows scrolls and follows", async () => {
    render(<Editable initial={rows(200)} />);
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard("{PageDown}");
    const after = Number(cellText()!.slice(1));
    expect(after).toBeGreaterThan(5);
    for (let i = 0; i < 40; i++) await user.keyboard("{ArrowDown}");
    expect(cellText()).toBe(`r${after + 40}`);
    expect(screen.getByRole("region", { name: "Rows" }).scrollTop).toBeGreaterThan(0);
  });

  test("Enter edits, Enter saves and keeps the focus on the cell for more navigation", async () => {
    const onSave = mock((_: string, __: string) => {});
    render(<Editable initial={rows(5)} onSave={onSave} />);
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard("{ArrowRight}{ArrowDown}{Enter}");
    const input = screen.getByRole("textbox", { name: "Edit name" });
    expect(document.activeElement).toBe(input);
    await user.clear(input);
    await user.type(input, "renamed{Enter}");
    expect(onSave).toHaveBeenCalledWith("r1", "renamed");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(cellText()).toBe("renamed");
    await user.keyboard("{ArrowDown}");
    expect(cellText()).toBe("row 2");
  });

  test("Tab saves and moves right; Escape cancels and returns to the cell", async () => {
    const onSave = mock((_: string, __: string) => {});
    render(<Editable initial={rows(5)} onSave={onSave} />);
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard("{ArrowRight}{Enter}");
    await user.type(screen.getByRole("textbox"), "!{Tab}");
    expect(onSave).toHaveBeenLastCalledWith("r0", "row 0!");
    expect(cellText()).toBe("0");
    await user.keyboard("{ArrowLeft}{Enter}");
    await user.type(screen.getByRole("textbox"), "zzz{Escape}");
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(cellText()).toBe("row 0!");
  });

  test("a click selects the cell: it takes the focus and is marked, and the keys go on from there", async () => {
    render(<Editable initial={rows(5)} />);
    const grid = screen.getByRole("grid", { name: "Rows" });
    expect(grid.querySelector("[aria-selected]")).toBeNull(); // nothing picked yet
    const user = userEvent.setup();
    const cell = screen.getByText("row 2").closest("td")!;
    await user.click(cell);
    expect(document.activeElement).toBe(cell);
    expect(cell.getAttribute("aria-selected")).toBe("true");
    expect(grid.querySelectorAll("[aria-selected]")).toHaveLength(1);
    await user.keyboard("{ArrowRight}");
    expect(cellText()).toBe("2");
    expect(cell.getAttribute("aria-selected")).toBeNull();
  });

  test("a double-click edits; Enter on a cell that cannot be edited activates it", async () => {
    render(<Editable initial={rows(5)} />);
    const user = userEvent.setup();
    await user.dblClick(screen.getByText("row 3"));
    expect(screen.getByRole("textbox", { name: "Edit name" })).toBeDefined();
    await user.keyboard("{Escape}");
    await user.keyboard("{ArrowLeft}{Enter}");
    expect(screen.getByLabelText("activated").textContent).toBe("r3:id");
    const readonly = screen.getByText("r3").closest("td")!;
    expect(readonly.getAttribute("aria-readonly")).toBe("true");
  });

  test("clicking another cell while editing leaves the edit unsaved, without editing the new cell", async () => {
    const onSave = mock((_: string, __: string) => {});
    render(<Editable initial={rows(5)} onSave={onSave} />);
    const user = userEvent.setup();
    await user.dblClick(screen.getByText("row 1"));
    await user.type(screen.getByRole("textbox"), "zzz");
    await user.click(screen.getByText("row 3"));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText("row 1")).toBeDefined();
  });

  test("when the focused row goes away, the focus moves to its neighbour instead of being lost", async () => {
    const data = rows(6);
    const { rerender } = render(
      <DataTable label="Rows" columns={columns} data={data} getRowId={(r) => r.id} grid={{}} />,
    );
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(cellText()).toBe("r2");
    rerender(
      <DataTable
        label="Rows"
        columns={columns}
        data={data.filter((r) => r.id !== "r2")}
        getRowId={(r) => r.id}
        grid={{}}
      />,
    );
    expect(cellText()).toBe("r3");
  });

  test("the focus stays on its row when rows arrive above it", async () => {
    const { rerender } = render(
      <DataTable label="Rows" columns={columns} data={rows(10)} getRowId={(r) => r.id} grid={{}} />,
    );
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(cellText()).toBe("r2");
    rerender(
      <DataTable
        label="Rows"
        columns={columns}
        data={[...rows(3, "new"), ...rows(10)]}
        getRowId={(r) => r.id}
        grid={{}}
      />,
    );
    await user.keyboard("{ArrowDown}");
    expect(cellText()).toBe("r3");
  });
});

describe("a list of lines (activate on click, follow the current cell)", () => {
  test("a click activates a cell that cannot be edited; an editable one still needs a double-click", async () => {
    const activate = mock();
    render(
      <DataTable
        label="Rows"
        columns={columns}
        data={rows(3)}
        getRowId={(r) => r.id}
        grid={{
          activateOnClick: true,
          canEdit: (_, c) => c === "name",
          renderEditor: () => <input aria-label="Edit name" />,
          onCellActivate: (r, c) => activate(`${r.id}:${c}`),
        }}
      />,
    );
    const user = userEvent.setup();
    const [first] = within(screen.getByRole("grid")).getAllByRole("row").slice(1);
    const [id, name] = within(first!).getAllByRole("gridcell");
    await user.click(id!);
    expect(activate.mock.calls).toEqual([["r0:id"]]);
    await user.click(name!);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  test("onCellFocus reports each move of the current cell, by arrows or a click", async () => {
    const moves: string[] = [];
    render(
      <DataTable
        label="Rows"
        columns={columns}
        data={rows(3)}
        getRowId={(r) => r.id}
        grid={{ onCellFocus: (r, c) => moves.push(`${r.id}:${c}`) }}
      />,
    );
    const user = userEvent.setup();
    const body = within(screen.getByRole("grid")).getAllByRole("row").slice(1);
    await user.click(within(body[0]!).getAllByRole("gridcell")[1]!);
    await user.keyboard("{ArrowDown}{ArrowRight}");
    expect(moves).toEqual(["r0:name", "r1:name", "r1:n"]);
  });
});
