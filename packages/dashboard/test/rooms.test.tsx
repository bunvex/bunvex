// The Rooms screen (AD-43, STUDY-165 §5.1): the open rooms and presence scopes by definition then args, a filter and
// a sort in the URL, a room's members a page at a time, a room that closes said as closed (not an error), a
// deployment without rooms as an empty state, no data without `viewMetrics`, and the polls' pace.
import { afterEach, describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import {
  type ConnectionStatus,
  DataSourceError,
  type PageRequest,
  type RoomInfo,
  type RoomRef,
} from "@bunvex/dashboard/data-source";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MEMBERS_PAGE, NO_ROOMS } from "../src/rooms/screen.tsx";
import { openedRoom, ROOMS_POLL_MS, roomsSummary, shortValue, shownRooms } from "../src/rooms/words.ts";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 9, 18, 12);
const DOC = `room|rooms:doc|{"id":"design-review"}`;
const SCOPE = `presence|presence:online|{"team":"acme"}`;
const source = (opts: Partial<ConstructorParameters<typeof MockDataSource>[0]> = {}) =>
  new MockDataSource({ seed: 4, now: NOW, executions: 3, logIntervalMs: 3_600_000, ...opts });

function mount(path: string, src = source()) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={src} history={history} />);
  return { history, src };
}
/** The grid's rows, each as its cells' text. */
const rowsOf = (grid: HTMLElement) =>
  within(grid)
    .getAllByRole("row")
    .slice(1)
    .map((r) =>
      within(r)
        .getAllByRole("gridcell")
        .map((c) => c.textContent ?? ""),
    );

afterEach(cleanup);

const room = (over: Partial<RoomInfo>): RoomInfo => ({
  key: "k",
  kind: "room",
  name: "rooms:doc",
  args: {},
  members: 1,
  connections: 1,
  openedAt: 0,
  ...over,
});

describe("the Rooms screen's words", () => {
  test("args on one line as the dashboard writes values, shortened past the limit", () => {
    expect(shortValue({ id: "a", n: { $integer: "BQAAAAAAAAA=" } })).toBe('{ id: "a", n: 5n }');
    expect(shortValue({ text: "x".repeat(100) }, 20)).toBe(`{ text: "xxxxxxxxxx…`);
    expect(shortValue({ text: "x".repeat(100) }, 20)).toHaveLength(20);
  });

  test("the order: as listed (name, then args), or the most members first; a filter keeps one definition", () => {
    const list = [
      room({ key: "a", name: "a:x", members: 1 }),
      room({ key: "b1", name: "b:y", members: 4 }),
      room({ key: "b2", name: "b:y", members: 4 }),
      room({ key: "c", name: "c:z", members: 9 }),
    ];
    expect(shownRooms(list, undefined, "name").map((r) => r.key)).toEqual(["a", "b1", "b2", "c"]);
    // ties keep the listed order
    expect(shownRooms(list, undefined, "members").map((r) => r.key)).toEqual(["c", "b1", "b2", "a"]);
    expect(shownRooms(list, "b:y", "name").map((r) => r.key)).toEqual(["b1", "b2"]);
    expect(shownRooms(list, "nope", "members")).toEqual([]);
    // the input is not reordered
    expect(list[0]!.key).toBe("a");
  });

  test("the summary counts rooms and scopes, members and connections", () => {
    expect(
      roomsSummary([room({ members: 5, connections: 5 }), room({ kind: "presence", members: 3, connections: 4 })]),
    ).toBe("2 open (1 room, 1 presence scope) · 8 members · 9 connections");
    expect(roomsSummary([room({})])).toBe("1 open (1 room, 0 presence scopes) · 1 member · 1 connection");
  });

  test("an opened room is open while listed, closed once a later list lacks it, unknown if never seen", () => {
    const r = room({ key: "x" });
    expect(openedRoom("x", [r], undefined)).toEqual({ state: "open", room: r });
    expect(openedRoom("x", [], r)).toEqual({ state: "closed", room: r });
    expect(openedRoom("x", [], room({ key: "other" }))).toEqual({ state: "unknown", key: "x" });
    expect(openedRoom("x", [], undefined)).toEqual({ state: "unknown", key: "x" });
  });
});

describe("the Rooms screen", () => {
  test("lists the open rooms and scopes by definition, then args, with members, connections and when they opened", async () => {
    mount("/rooms");
    await screen.findByRole("heading", { level: 1, name: "Rooms" });
    const grid = await screen.findByRole("grid", { name: "Open rooms" });
    await waitFor(() => expect(rowsOf(grid)).toHaveLength(2));
    const [scope, doc] = rowsOf(grid);
    expect(scope!.slice(0, 5)).toEqual(["presence:online", "Presence scope", '{ team: "acme" }', "3", "4"]);
    expect(doc!.slice(0, 5)).toEqual(["rooms:doc", "Room", '{ id: "design-review" }', "5", "5"]);
    // the mock opened it 3 hours before its clock (the screen says it against the viewer's clock)
    expect(doc![5]).toMatch(/^\d+ hours ago$/);
    expect(screen.getByTestId("rooms-summary").textContent).toBe(
      "2 open (1 room, 1 presence scope) · 8 members · 9 connections",
    );
    // it is in the sidebar, under Observe
    const nav = screen.getByRole("navigation", { name: "Dashboard" });
    expect(within(nav).getByRole("link", { name: "Rooms" }).getAttribute("aria-current")).toBe("page");
    await expectAccessible();
  });

  test("the filter by definition and the sort by members are in the URL", async () => {
    const { history } = mount("/rooms?sort=members");
    const grid = await screen.findByRole("grid", { name: "Open rooms" });
    await waitFor(() => expect(rowsOf(grid).map((r) => r[0])).toEqual(["rooms:doc", "presence:online"]));
    expect(screen.getByRole("button", { name: "Members" }).getAttribute("aria-pressed")).toBe("true");
    await userEvent.setup().click(screen.getByRole("button", { name: "Name" }));
    await waitFor(() => expect(rowsOf(grid).map((r) => r[0])).toEqual(["presence:online", "rooms:doc"]));
    expect(history.location.search).not.toContain("sort=");
    cleanup();
    mount("/rooms?name=presence:online");
    const filtered = await screen.findByRole("grid", { name: "Open rooms" });
    await waitFor(() => expect(rowsOf(filtered).map((r) => r[0])).toEqual(["presence:online"]));
    cleanup();
    // a definition with no open room: said, with its name kept in the filter
    mount("/rooms?name=rooms:board");
    expect(await screen.findByText("No room of rooms:board is open.")).toBeDefined();
  });

  test("a room opens with its members: who, their presence, the flags, connections and times", async () => {
    const { history } = mount("/rooms");
    const grid = await screen.findByRole("grid", { name: "Open rooms" });
    await waitFor(() => expect(rowsOf(grid)).toHaveLength(2));
    await userEvent.setup().click(within(grid).getByText("rooms:doc"));
    await waitFor(() => expect(history.location.search).toContain("room="));
    const panel = await screen.findByRole("complementary", { name: "rooms:doc" });
    const members = within(panel).getByRole("region", { name: "Members" });
    await waitFor(() => expect(within(members).getAllByRole("listitem")).toHaveLength(5));
    const items = within(members).getAllByRole("listitem");
    expect(items[0]!.getAttribute("aria-label")).toMatch(/^\S+, user_\w+$/);
    // the signed-out viewer follows but cannot publish
    const guest = items.find((li) => li.textContent?.includes("Signed out"))!;
    expect(within(guest).getByText("Cannot publish")).toBeDefined();
    expect(within(guest).getByText(/^\{ x: [\d.]+, y: [\d.]+, name: "guest" \}$/)).toBeDefined();
    expect(within(panel).getByText("Kind").nextSibling?.textContent).toBe("Room");
    await expectAccessible();
  });

  test("a scope's users: their state, idle, their tabs", async () => {
    mount(`/rooms?room=${encodeURIComponent(SCOPE)}`);
    const panel = await screen.findByRole("complementary", { name: "presence:online" });
    const users = within(panel).getByRole("region", { name: "Members" });
    await waitFor(() => expect(within(users).getAllByRole("listitem")).toHaveLength(3));
    const ana = within(users).getByRole("listitem", { name: "user_ana" });
    expect(within(ana).getByText("Tabs").nextSibling?.textContent).toBe("2");
    expect(within(ana).getByText("State")).toBeDefined();
    const carla = within(users).getByRole("listitem", { name: "user_carla" });
    expect(within(carla).getByText("Idle")).toBeDefined();
    expect(within(carla).getByText(/status: "away"/)).toBeDefined();
  });

  test("a room that closes stays in its panel, said as closed, not as an error; the list drops it", async () => {
    const { src } = mount(`/rooms?room=${encodeURIComponent(DOC)}`);
    const panel = await screen.findByRole("complementary", { name: "rooms:doc" });
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(5));
    expect(src.rooms.close(DOC)).toBe(true);
    const status = await within(panel).findByRole("status", {}, { timeout: ROOMS_POLL_MS * 3 });
    expect(status.textContent).toContain("Closed");
    expect(screen.queryByRole("alert")).toBeNull();
    // what it showed last stays: a closed room's members are not asked again
    await new Promise((r) => setTimeout(r, ROOMS_POLL_MS * 1.5));
    expect(within(panel).getAllByRole("listitem")).toHaveLength(5);
    const grid = screen.getByRole("grid", { name: "Open rooms" });
    expect(rowsOf(grid).map((r) => r[0])).toEqual(["presence:online"]);
    await expectAccessible();
  });

  test("a link to a room that is not open says so", async () => {
    mount(`/rooms?room=${encodeURIComponent('room|rooms:doc|{"id":"gone"}')}`);
    const panel = await screen.findByRole("complementary", { name: "Room" });
    expect(within(panel).getByText("This room is not open: it closed, or the link is old.")).toBeDefined();
  });

  test("a big room's members come a page at a time", async () => {
    const src = source();
    const list = src.listRoomMembers.bind(src);
    const asked: PageRequest[] = [];
    // pages of two stand for pages of a hundred
    src.listRoomMembers = (r: RoomRef, page: PageRequest, o?: Parameters<typeof list>[2]) => {
      asked.push(page);
      return list(r, { ...page, numItems: 2 }, o);
    };
    mount(`/rooms?room=${encodeURIComponent(DOC)}`, src);
    const panel = await screen.findByRole("complementary", { name: "rooms:doc" });
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(2));
    expect(asked[0]).toEqual({ numItems: MEMBERS_PAGE, cursor: null });
    const user = userEvent.setup();
    await user.click(within(panel).getByRole("button", { name: `Load ${MEMBERS_PAGE} more` }));
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(4));
    await user.click(within(panel).getByRole("button", { name: `Load ${MEMBERS_PAGE} more` }));
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(5));
    expect(within(panel).queryByRole("button", { name: /^Load/ })).toBeNull();
    // each member once, in memberId order
    const ids = within(panel)
      .getAllByRole("listitem")
      .map((li) => li.getAttribute("aria-label")!.split(",")[0]);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(5);
  });

  test("a deployment without rooms: an empty state with its words, not an error", async () => {
    const src = source();
    src.listRooms = () => Promise.reject(new DataSourceError("not_found", NO_ROOMS));
    mount("/rooms", src);
    expect(await screen.findByText(NO_ROOMS)).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("grid", { name: "Open rooms" })).toBeNull();
    await expectAccessible();
  });

  test("another failure is an error with a retry", async () => {
    const src = source();
    src.listRooms = () => Promise.reject(new DataSourceError("unavailable", "down"));
    mount("/rooms", src);
    // retried once, as every unavailable read
    const alert = await screen.findByRole("alert", {}, { timeout: 3000 });
    expect(alert.textContent).toContain("The deployment did not answer");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeDefined();
  });

  test("a credential without viewMetrics sees no rooms", async () => {
    mount("/rooms", source({ capabilities: { operations: ["viewData"], readOnly: true } }));
    expect(await screen.findByText("This credential cannot view the deployment's rooms.")).toBeDefined();
    expect(screen.queryByRole("grid", { name: "Open rooms" })).toBeNull();
  });
});

describe("the polls", () => {
  test("the list and the open room's members are asked again every second", async () => {
    const src = source();
    const asked = { rooms: 0, members: 0 };
    const listRooms = src.listRooms.bind(src);
    const listRoomMembers = src.listRoomMembers.bind(src);
    src.listRooms = (o) => {
      asked.rooms++;
      return listRooms(o);
    };
    src.listRoomMembers = (r, p, o) => {
      asked.members++;
      return listRoomMembers(r, p, o);
    };
    mount(`/rooms?room=${encodeURIComponent(DOC)}`, src);
    await screen.findByRole("complementary", { name: "rooms:doc" });
    await waitFor(() => expect(asked.members).toBeGreaterThan(0));
    const start = { ...asked };
    await new Promise((r) => setTimeout(r, ROOMS_POLL_MS * 2 + 300));
    expect(asked.rooms - start.rooms).toBeGreaterThanOrEqual(2);
    expect(asked.rooms - start.rooms).toBeLessThanOrEqual(3);
    expect(asked.members - start.members).toBeGreaterThanOrEqual(2);
    expect(asked.members - start.members).toBeLessThanOrEqual(3);
  });

  test("nothing is asked while the deployment is disconnected; asked again on return", async () => {
    const src = source();
    const listeners = new Set<(s: ConnectionStatus) => void>();
    Object.assign(src, {
      watchConnection(onStatus: (s: ConnectionStatus) => void) {
        listeners.add(onStatus);
        return () => listeners.delete(onStatus);
      },
    });
    const set = (s: ConnectionStatus) =>
      act(() => {
        for (const l of listeners) l(s);
      });
    let asked = 0;
    const listRooms = src.listRooms.bind(src);
    src.listRooms = (o) => {
      asked++;
      return listRooms(o);
    };
    mount("/rooms", src);
    await screen.findByRole("grid", { name: "Open rooms" });
    await waitFor(() => expect(asked).toBeGreaterThan(0));
    set("disconnected");
    const before = asked;
    await new Promise((r) => setTimeout(r, ROOMS_POLL_MS + 300));
    expect(asked).toBe(before);
    set("connected");
    await waitFor(() => expect(asked).toBeGreaterThan(before));
  });
});
