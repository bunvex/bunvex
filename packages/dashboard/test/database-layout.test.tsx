import { describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const source = () =>
  new MockDataSource({ seed: 5, now: NOW, documents: { tasks: 5, users: 4, messages: 2, imports: 2 }, executions: 5 });

function mount(path: string) {
  return render(<Dashboard dataSource={source()} history={createMemoryHistory({ initialEntries: [path] })} />);
}
const heading = (name: string) => screen.findByRole("heading", { level: 1, name });
const headers = () =>
  within(screen.getByRole("grid"))
    .getAllByRole("columnheader")
    .map((h) => h.textContent)
    .slice(1); // [0]: the selection checkbox

describe("columns, per table, kept in this browser", () => {
  test("hide, reorder and reset from the Columns panel; the layout survives a reload", async () => {
    const first = mount("/database/tasks");
    await heading("tasks");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Columns" }));
    const panel = await screen.findByRole("complementary", { name: "Columns of tasks" });
    await user.click(within(panel).getByRole("checkbox", { name: "Show done" }));
    await user.click(within(panel).getByRole("button", { name: "Move owner up" }));
    // owner moved above its neighbour in the panel's list, done — hidden now
    expect(headers()).toEqual(["_id", "text", "owner", "priority", "tags", "_creationTime"]);
    await expectAccessible(panel);
    first.unmount();

    mount("/database/tasks");
    await heading("tasks");
    expect(headers()).toEqual(["_id", "text", "owner", "priority", "tags", "_creationTime"]);
    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(
      within(await screen.findByRole("complementary", { name: "Columns of tasks" })).getByRole("button", {
        name: "Reset columns",
      }),
    );
    expect(headers()).toEqual(["_id", "text", "done", "owner", "priority", "tags", "_creationTime"]);
  });

  test("a width set on a header is kept for that table only", async () => {
    const first = mount("/database/tasks");
    await heading("tasks");
    screen.getByRole("separator", { name: "Resize text" }).focus();
    await userEvent.setup().keyboard("{Shift>}{ArrowRight}{/Shift}");
    first.unmount();

    const again = mount("/database/tasks");
    await heading("tasks");
    expect(screen.getByRole("separator", { name: "Resize text" }).getAttribute("aria-valuenow")).toBe("244");
    again.unmount();
    mount("/database/users");
    await heading("users");
    expect(screen.getByRole("separator", { name: "Resize name" }).getAttribute("aria-valuenow")).toBe("180");
  });
});

describe("room for the table", () => {
  test("the table list is resizable from its edge, and keeps its width", async () => {
    const first = mount("/database/tasks");
    await heading("tasks");
    const nav = screen.getByRole("navigation", { name: "Tables" });
    const handle = within(nav).getByRole("separator", { name: "Resize the table list" });
    expect([handle.getAttribute("aria-valuenow"), nav.style.width]).toEqual(["224", "224px"]);
    handle.focus();
    const user = userEvent.setup();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}{ArrowRight}");
    expect(nav.style.width).toBe("304px");
    await user.keyboard("{Shift>}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}"); // clamped
    expect(nav.style.width).toBe("480px");
    await expectAccessible(nav);
    first.unmount();
    mount("/database/tasks");
    await heading("tasks");
    const again = screen.getByRole("navigation", { name: "Tables" });
    expect(again.style.width).toBe("480px");
    within(again).getByRole("separator").focus();
    await user.keyboard("{Enter}"); // back to the default
    expect(again.style.width).toBe("224px");
  });

  test("below 1 536 px the side panel is a drawer over the table, beside it above", async () => {
    mount("/database/tasks?panel=indexes");
    const panel = await screen.findByRole("complementary", { name: "Indexes of tasks" });
    // layout is the browser's; here the classes say it: fixed and on top by default, in the flow at 2xl
    expect(panel.className).toMatch(/\bfixed\b.*\bz-30\b/);
    expect(panel.className).toContain("2xl:static");
  });
});
