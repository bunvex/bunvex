import { beforeEach, describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fuzzyScore, looksLikeId, type PaletteItem, rememberPick, searchItems } from "../src/palette/model.ts";
import { expectAccessible } from "./axe.ts";

function mount(path = "/", src = new MockDataSource({ seed: 3, executions: 50 })) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={src} history={history} />);
  return { history, src };
}
const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await screen.findByRole("heading", { level: 1 });
  await user.keyboard("{Control>}k{/Control}");
  return screen.findByRole("combobox", { name: "Search screens, tables, functions and actions" });
};
const options = () => within(screen.getByRole("listbox", { name: "Results" })).getAllByRole("option");

beforeEach(() => localStorage.clear());

describe("the palette's search", () => {
  const item = (title: string, extra: Partial<PaletteItem> = {}): PaletteItem =>
    ({ id: title, kind: "screen", title, go: { to: "/" }, ...extra }) as PaletteItem;

  test("a subsequence matches; a substring at the start ranks first; nothing out of order matches", () => {
    expect(fuzzyScore("dbs", "Database")).not.toBeNull();
    expect(fuzzyScore("xyz", "Database")).toBeNull();
    expect(fuzzyScore("sdb", "Database")).toBeNull();
    const items = [item("Schedules"), item("Database"), item("Data browser settings")];
    expect(searchItems(items, "data").map((i) => i.title)).toEqual(["Database", "Data browser settings"]);
    expect(searchItems(items, "sch").map((i) => i.title)[0]).toBe("Schedules");
    expect(searchItems([item("Logs", { keywords: ["audit"] })], "audit").length).toBe(1);
  });

  test("recent picks: newest first, no duplicates, at most five; ids look like ids", () => {
    expect(rememberPick(["a", "b"], "b")).toEqual(["b", "a"]);
    expect(rememberPick(["1", "2", "3", "4", "5"], "6")).toEqual(["6", "1", "2", "3", "4"]);
    expect(looksLikeId("m3xpc4yf0cbc4c6n6ahynerbyshedsma")).toBe(true);
    expect(looksLikeId("users")).toBe(false);
  });
});

describe("the command palette", () => {
  test("Ctrl+K opens it; typing finds a table; Enter goes there; it is remembered as recent", async () => {
    const user = userEvent.setup();
    const { history } = mount("/");
    const box = await open(user);
    // compared as a boolean: a failing toBe on two DOM nodes prints them whole
    await waitFor(() => expect(document.activeElement === box).toBe(true));
    await expectAccessible();
    await user.type(box, "users");
    await waitFor(() => expect(options()[0]!.textContent).toContain("users"));
    expect(box.getAttribute("aria-activedescendant")).toBe(options()[0]!.id);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(history.location.pathname).toBe("/database/users"));
    await waitFor(() =>
      expect(screen.queryByRole("combobox", { name: "Search screens, tables, functions and actions" }) === null).toBe(
        true,
      ),
    );
    await user.keyboard("{Control>}k{/Control}");
    await screen.findByText("Recent");
    expect(options()[0]!.textContent).toContain("users");
    await user.keyboard("{Escape}");
  });

  test("arrows move the active option; Escape closes; screens, settings and functions are all there", async () => {
    const user = userEvent.setup();
    const { history } = mount("/");
    const box = await open(user);
    await user.type(box, "environment");
    await waitFor(() => expect(options()[0]!.textContent).toContain("Environment variables"));
    await user.clear(box);
    await user.type(box, "tasks:");
    await waitFor(() => expect(options().length).toBeGreaterThan(1));
    await user.keyboard("{ArrowDown}");
    expect(options()[1]!.getAttribute("aria-selected")).toBe("true");
    const second = options()[1]!.textContent!;
    await user.keyboard("{Enter}");
    // the second function: its path is the option's text up to the kind
    await waitFor(() =>
      expect(decodeURIComponent(history.location.search)).toContain(
        `function=${second.replace(/(query|mutation|action)$/, "")}`,
      ),
    );
    await user.keyboard("{Control>}k{/Control}");
    await screen.findByRole("combobox", { name: "Search screens, tables, functions and actions" });
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("combobox", { name: "Search screens, tables, functions and actions" }) === null).toBe(
        true,
      ),
    );
  });

  test("actions follow the credential: a read-only key gets no Add documents", async () => {
    const user = userEvent.setup();
    mount("/database/users");
    let box = await open(user);
    await user.type(box, "add documents");
    await waitFor(() => expect(options()[0]!.textContent).toContain("Add documents to users"));
    await user.keyboard("{Escape}");
    cleanup();
    const ro = new MockDataSource({
      seed: 3,
      executions: 50,
      capabilities: { operations: ["viewData"], readOnly: true },
    });
    mount("/database/users", ro);
    box = await open(user);
    await user.type(box, "add documents");
    await waitFor(() => expect(screen.queryByText(/Add documents to/) === null).toBe(true));
    await user.keyboard("{Escape}");
  });
});
