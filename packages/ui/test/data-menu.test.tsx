import { describe, expect, mock, test } from "bun:test";
import { DataTable, dataTableColumns } from "@bunvex/ui/components/data-table";
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@bunvex/ui/components/dropdown-menu";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expectAccessible } from "./axe.ts";

type Row = { id: string; name: string };
const col = dataTableColumns<Row>();
const columns = col.columns([col.accessor("id", { header: "Id" }), col.accessor("name", { header: "Name" })]);
const data: Row[] = [
  { id: "a", name: "Ada" },
  { id: "b", name: "Bob" },
];

function Grid(props: { onPick?: (what: string) => void; onKey?: (key: string) => boolean }) {
  return (
    <main>
      <DataTable
        label="Rows"
        columns={columns}
        data={data}
        getRowId={(r) => r.id}
        grid={{
          canEdit: (_, c) => c === "name",
          renderEditor: ({ done }) => (
            <input aria-label="Edit name" onKeyDown={(e) => e.key === "Escape" && done("cancel")} />
          ),
          cellMenu: ({ row, columnId, edit }) => (
            <>
              <DropdownMenuItem onClick={() => props.onPick?.(`${row.id}:${columnId}`)}>Pick</DropdownMenuItem>
              <DropdownMenuItem onClick={edit}>Edit</DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem onClick={() => props.onPick?.(`more ${row.id}`)}>Deeper</DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </>
          ),
          onCellKey: (e) => props.onKey?.(e.key) ?? false,
        }}
      />
    </main>
  );
}

const cell = (text: string) => screen.getByRole("gridcell", { name: text });

describe("a cell's context menu", () => {
  test("Shift+F10 opens it on the focused cell; an item acts on that cell; the focus comes back", async () => {
    const onPick = mock((_: string) => {});
    render(<Grid onPick={onPick} />);
    const user = userEvent.setup();
    await user.click(cell("Bob"));
    await user.keyboard("{Shift>}{F10}{/Shift}");
    const menu = await screen.findByRole("menu", { name: "Actions on name" });
    await expectAccessible(menu); // portalled: checked on its own, like a dialog
    await user.click(screen.getByRole("menuitem", { name: "Pick" }));
    expect(onPick).toHaveBeenCalledWith("b:name");
    await waitFor(() => expect(menu.isConnected).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(cell("Bob")));
  });

  test("a right-click opens it at the pointer on the cell clicked; Escape closes it", async () => {
    const onPick = mock((_: string) => {});
    render(<Grid onPick={onPick} />);
    const user = userEvent.setup();
    fireEvent.contextMenu(cell("a"), { clientX: 10, clientY: 10 });
    await screen.findByRole("menu", { name: "Actions on id" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(cell("a")));
  });

  test("the Menu key and Ctrl+Enter open it too; its Edit starts the cell's editor", async () => {
    render(<Grid />);
    const user = userEvent.setup();
    await user.click(cell("Ada"));
    await user.keyboard("{ContextMenu}");
    await screen.findByRole("menu");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    expect(await screen.findByRole("textbox", { name: "Edit name" })).toBeDefined();
  });

  test("the caller's keys run first; a key it does not take moves as usual", async () => {
    const onKey = mock((key: string) => key === "x");
    render(<Grid onKey={onKey} />);
    const user = userEvent.setup();
    await user.click(cell("Ada"));
    await user.keyboard("x");
    expect(onKey).toHaveBeenCalledWith("x");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(cell("Bob"));
  });

  test("a submenu opens without closing the menu (Base UI calls it a sibling)", async () => {
    const onPick = mock((_: string) => {});
    render(<Grid onPick={onPick} />);
    const user = userEvent.setup();
    await user.click(cell("Ada"));
    await user.keyboard("{Shift>}{F10}{/Shift}");
    await screen.findByRole("menu");
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("More");
    await user.keyboard("{ArrowRight}");
    await user.click(await screen.findByRole("menuitem", { name: "Deeper" }));
    expect(onPick).toHaveBeenCalledWith("more a");
  });
});
