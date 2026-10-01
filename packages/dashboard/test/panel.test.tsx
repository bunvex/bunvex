import { beforeEach, describe, expect, test } from "bun:test";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { PANEL_MAX, PANEL_MIN, Panel } from "../src/shell/panel.tsx";
import { expectAccessible } from "./axe.ts";

beforeEach(() => localStorage.clear());

function Screen({ kind = "test", focusOnOpen }: { kind?: string; focusOnOpen?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <main className="flex">
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <Panel kind={kind} title="Details" onClose={() => setOpen(false)} focusOnOpen={focusOnOpen}>
          <p>Inside</p>
          <button type="button">Act</button>
        </Panel>
      )}
    </main>
  );
}

const width = (panel: HTMLElement) => Number(panel.style.getPropertyValue("--panel-width").replace("px", ""));

describe("the shared side panel (UI-01 §22.1)", () => {
  test("a named complementary landmark; it takes the focus on open and gives it back on close", async () => {
    render(<Screen />);
    const user = userEvent.setup();
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    const panel = screen.getByRole("complementary", { name: "Details" });
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Details" }));
    await expectAccessible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(panel.isConnected).toBe(false);
  });

  test("a screen that keeps the focus (a list the panel follows) keeps it", async () => {
    render(<Screen focusOnOpen={false} />);
    const user = userEvent.setup();
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    screen.getByRole("complementary", { name: "Details" });
    expect(document.activeElement).toBe(opener);
  });

  test("its left edge resizes it (Left widens, Right narrows, Enter resets), within bounds, kept per kind", async () => {
    const { unmount } = render(<Screen kind="logs-details" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open" }));
    const panel = screen.getByRole("complementary", { name: "Details" });
    const handle = screen.getByRole("separator", { name: "Resize the panel" });
    const start = width(panel);
    act(() => handle.focus());
    await user.keyboard("{ArrowLeft}");
    expect(width(panel)).toBe(start + 16);
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(width(panel)).toBe(start + 16 - 64);
    expect(handle.getAttribute("aria-valuenow")).toBe(String(start - 48));
    expect(localStorage.getItem("bunvex-dashboard:panel-width:logs-details")).toBe(String(start - 48));
    for (let i = 0; i < 40; i++) await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(width(panel)).toBe(PANEL_MIN);
    for (let i = 0; i < 40; i++) await user.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    expect(width(panel)).toBe(PANEL_MAX);
    unmount();
    // a new panel of the same kind opens at the kept width; another kind at the default
    render(<Screen kind="logs-details" />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(width(screen.getByRole("complementary"))).toBe(PANEL_MAX);
    act(() => screen.getByRole("separator").focus());
    await user.keyboard("{Enter}");
    expect(width(screen.getByRole("complementary"))).toBe(start);
    expect(localStorage.getItem("bunvex-dashboard:panel-width:logs-details")).toBeNull();
  });
});
