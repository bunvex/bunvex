import { describe, expect, test } from "bun:test";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@bunvex/ui/components/dropdown-menu";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

function Menu() {
  return (
    <DropdownMenu open>
      <DropdownMenuContent aria-label="Actions">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Filter by name</DropdownMenuSubTrigger>
          <DropdownMenuSubContent aria-label="Filters">
            <DropdownMenuItem>equals “Ada”</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem>Copy name</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

async function openSub(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("menuitem", { name: "Filter by name" });
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement?.textContent).toBe("Filter by name");
  await user.keyboard("{ArrowRight}");
  await screen.findByRole("menuitem", { name: "equals “Ada”" });
}

describe("DropdownMenuSub", () => {
  test("stays open when the parent menu takes the focus on the way into it (Base UI's pointer leave)", async () => {
    render(<Menu />);
    const user = userEvent.setup();
    await openSub(user);
    // what Base UI does when the pointer leaves the trigger towards the submenu: focus the parent popup
    act(() => screen.getByRole("menu", { name: "Actions" }).focus());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("menuitem", { name: "equals “Ada”" })).not.toBeNull();
  });

  test("still closes on Escape", async () => {
    render(<Menu />);
    const user = userEvent.setup();
    await openSub(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "equals “Ada”" })).toBeNull());
  });
});
