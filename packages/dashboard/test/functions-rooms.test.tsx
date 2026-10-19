// The room and presence definitions on the Functions screen (AD-43, STUDY-165 §5.1): their own list under the
// function tree (which stays the functions' alone, as Convex's), one opened as `?room=` with its validators and
// events, the tree's search over both, and nothing for a deployment without rooms.
import { afterEach, describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { DataSourceError } from "@bunvex/dashboard/data-source";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { matchDefinitions } from "../src/functions/rooms.tsx";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 9, 18, 12);
const source = () => new MockDataSource({ seed: 4, now: NOW, executions: 3, logIntervalMs: 3_600_000 });

function mount(path: string, src = source()) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={src} history={history} />);
  return { history, src };
}

afterEach(cleanup);

const tree = () => screen.getByRole("navigation", { name: "Functions" });
const definitionsList = () => screen.findByRole("navigation", { name: "Rooms and presence" });
const noDefinitions = () => expect(screen.queryByRole("navigation", { name: "Rooms and presence" })).toBeNull();

describe("room and presence definitions on the Functions screen", () => {
  test("listed under the tree, apart from it; the tree holds the functions only", async () => {
    const { src } = mount("/functions");
    await screen.findByRole("heading", { level: 1, name: "Functions" });
    const list = await definitionsList();
    expect(
      within(list)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["presence:online, presence scope", "rooms:doc, room"]);
    // the tree's links are the functions', every one, and nothing else
    const functions = await src.listFunctions();
    expect(within(tree()).getAllByRole("link")).toHaveLength(functions.length);
    expect(tree().contains(list)).toBe(false);
    await expectAccessible();
  });

  test("a room opens with its args, presence and events; a link to its open rooms", async () => {
    const { history } = mount("/functions");
    const list = await definitionsList();
    await userEvent.setup().click(within(list).getByRole("link", { name: /^rooms:doc/ }));
    await waitFor(() => expect(history.location.search).toContain("room=rooms%3Adoc"));
    await screen.findByRole("heading", { level: 1, name: "rooms:doc" });
    expect(screen.getByText("Room in")).toBeDefined();
    expect(screen.getByText("rooms.js")).toBeDefined();
    const args = screen.getByRole("region", { name: "Arguments validator" });
    expect(args.textContent).toContain("id: v.string()");
    const presence = screen.getByRole("region", { name: "Presence validator" });
    expect(presence.textContent).toContain("x: v.float64()");
    const events = screen.getByRole("region", { name: "Events" });
    expect(within(events).getByRole("listitem", { name: "ping" }).textContent).toContain("at: v.float64()");
    expect(within(events).getByRole("listitem", { name: "reaction" }).textContent).toContain("emoji: v.string()");
    expect(
      within(list)
        .getByRole("link", { name: /^rooms:doc/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByRole("link", { name: "Open rooms" }).getAttribute("href")).toBe("/rooms?name=rooms%3Adoc");
    await expectAccessible();
  });

  test("a scope shows its state validator, and says it declares no events", async () => {
    mount("/functions?room=presence:online");
    await screen.findByRole("heading", { level: 1, name: "presence:online" });
    expect(screen.getByText("Presence scope in")).toBeDefined();
    expect(screen.getByRole("region", { name: "State validator" }).textContent).toContain("status: v.string()");
    expect(screen.queryByRole("region", { name: "Presence validator" })).toBeNull();
    expect(within(screen.getByRole("region", { name: "Events" })).getByText("None declared.")).toBeDefined();
  });

  test("the search filters both lists; a function link still opens a function", async () => {
    mount("/functions");
    await definitionsList();
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: "Search functions" }), "online");
    const list = await definitionsList();
    expect(within(list).getAllByRole("link")).toHaveLength(1);
    await user.clear(screen.getByRole("searchbox", { name: "Search functions" }));
    await user.type(screen.getByRole("searchbox", { name: "Search functions" }), "zzz-nothing");
    await waitFor(noDefinitions);
    expect(matchDefinitions([], "x")).toEqual([]);
  });

  test("an unknown definition says so", async () => {
    mount("/functions?room=rooms:gone");
    expect(
      await screen.findByText("There is no room or presence definition rooms:gone. Pick one on the left."),
    ).toBeDefined();
  });

  test("a deployment without rooms, or a source without the method: no list, the functions as before", async () => {
    const src = source();
    src.listRoomDefinitions = () =>
      Promise.reject(new DataSourceError("not_found", "This deployment does not run rooms."));
    mount("/functions", src);
    await screen.findByRole("heading", { level: 1, name: "Functions" });
    await new Promise((r) => setTimeout(r, 50));
    noDefinitions();
    expect(screen.queryByRole("alert")).toBeNull();
    cleanup();
    const bare = source();
    // biome-ignore lint/suspicious/noExplicitAny: removing an optional method
    (bare as any).listRoomDefinitions = undefined;
    mount("/functions", bare);
    await screen.findByRole("heading", { level: 1, name: "Functions" });
    noDefinitions();
  });
});
