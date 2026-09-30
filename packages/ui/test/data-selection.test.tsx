import { describe, expect, test } from "bun:test";
import { DataTable, dataTableColumns } from "@bunvex/ui/components/data-table";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expectAccessible } from "./axe.ts";

type Row = { id: string; name: string };
const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `row ${i}` }));
const col = dataTableColumns<Row>();
const columns = col.columns([col.accessor("name", { header: "Name" })]);

function Selectable({ data }: { data: Row[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  return (
    <>
      <DataTable
        label="Rows"
        columns={columns}
        data={data}
        getRowId={(r) => r.id}
        grid={{}}
        selection={{ selected, onChange: setSelected, describe: (r) => r.name }}
      />
      <output aria-label="selected">{[...selected].sort().join(",")}</output>
    </>
  );
}
const selectedIds = () => screen.getByLabelText("selected").textContent;
const box = (name: string) => screen.getByRole("checkbox", { name: `Select row ${name}` });

describe("DataTable selection", () => {
  test("a checkbox per row, named after the row; clicking toggles it", async () => {
    render(<Selectable data={rows(5)} />);
    const user = userEvent.setup();
    await user.click(box("row 1"));
    await user.click(box("row 3"));
    expect(selectedIds()).toBe("r1,r3");
    await user.click(box("row 1"));
    expect(selectedIds()).toBe("r3");
    expect(box("row 3").getAttribute("aria-checked")).toBe("true");
    await expectAccessible();
  });

  test("Shift-click selects every row since the last one toggled", async () => {
    render(<Selectable data={rows(8)} />);
    const user = userEvent.setup();
    await user.click(box("row 2"));
    await user.keyboard("{Shift>}");
    await user.click(box("row 5"));
    await user.keyboard("{/Shift}");
    expect(selectedIds()).toBe("r2,r3,r4,r5");
  });

  test("the header checkbox selects every loaded row, then clears them, and shows a partial selection", async () => {
    render(<Selectable data={rows(4)} />);
    const user = userEvent.setup();
    const all = screen.getByRole("checkbox", { name: "Select every loaded row" });
    await user.click(box("row 0"));
    expect(all.getAttribute("aria-checked")).toBe("mixed");
    await user.click(all);
    expect(selectedIds()).toBe("r0,r1,r2,r3");
    await user.click(all);
    expect(selectedIds()).toBe("");
  });

  test("from the keyboard: the checkbox column is a grid column; Space toggles, Shift+Space a range", async () => {
    render(<Selectable data={rows(6)} />);
    const grid = screen.getByRole("grid", { name: "Rows" });
    const user = userEvent.setup();
    await user.tab();
    expect(within(document.activeElement as HTMLElement).getByRole("checkbox")).toBeDefined();
    await user.keyboard(" {ArrowDown}{ArrowDown}{Shift>} {/Shift}");
    expect(selectedIds()).toBe("r0,r1,r2");
    await user.keyboard("{ArrowRight}{ArrowLeft}{Enter}");
    expect(selectedIds()).toBe("r0,r1");
    expect(grid.querySelector("td[aria-readonly]")?.textContent).toBe("row 0"); // data cells without an editor
  });
});
