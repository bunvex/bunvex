// A room's event tap and actions (AD-43 steps 5 and 6, STUDY-166): the tap's rows (newest first, notices where
// events were dropped or missed, pause, clear, a filter), the panel following `watchRoomEvents` and stopping on
// close, a terminal error and a closed room said as such; then the actions, each confirmed in a dialog with the
// counts already loaded — a test event (with the server's refusals in the dialog), a removal, a close (and a null
// result said as "already") — and none of them for a read-only credential.
import { afterEach, describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import {
  DataSourceError,
  type DataSourceError as DataSourceErrorType,
  type RoomEvent,
  type RoomEventsInfo,
} from "@bunvex/dashboard/data-source";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BACK_ONLY_IF, eventTemplate, parseEventData } from "../src/rooms/actions.tsx";
import {
  emptyTap,
  OMITTED,
  TAP_ROWS_MAX,
  tapBatch,
  tapCleared,
  tapFiltered,
  tapPaused,
  tapWaiting,
} from "../src/rooms/tap.ts";
import { ROOMS_POLL_MS } from "../src/rooms/words.ts";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 9, 18, 12);
const DOC = `room|rooms:doc|{"id":"design-review"}`;
const SCOPE = `presence|presence:online|{"team":"acme"}`;
// no waves of the mock's own: a test sends what it expects
const source = (opts: Partial<ConstructorParameters<typeof MockDataSource>[0]> = {}) =>
  new MockDataSource({
    seed: 4,
    now: NOW,
    executions: 3,
    logIntervalMs: 3_600_000,
    roomEventIntervalMs: 1e12,
    ...opts,
  });

function mount(path: string, src = source()) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const view = render(<Dashboard dataSource={src} history={history} />);
  return { history, src, view };
}
const docPanel = () => screen.findByRole("complementary", { name: "rooms:doc" });
/** The tap's rows, each as its cells' text. */
const tapRows = (panel: HTMLElement) =>
  within(within(panel).getByRole("grid", { name: "Room events" }))
    .queryAllByRole("row")
    .slice(1)
    .map((r) =>
      within(r)
        .queryAllByRole("gridcell")
        .map((c) => c.textContent ?? ""),
    )
    .filter((cells) => cells.length > 0);
const members = (panel: HTMLElement) => within(within(panel).getByRole("region", { name: "Members" }));

afterEach(cleanup);

const ev = (seq: number, over: Partial<RoomEvent> = {}): RoomEvent => ({
  seq,
  at: NOW + seq,
  event: "wave",
  from: "m1",
  size: 2,
  data: {},
  ...over,
});
const OK: RoomEventsInfo = { dropped: 0, gap: false };

describe("the tap's rows", () => {
  test("newest first; a batch's notices come before its events; ids stay unique when seq starts again", () => {
    let t = tapBatch(emptyTap, [ev(1), ev(2)], OK, NOW);
    t = tapBatch(t, [ev(5)], { dropped: 2, gap: false }, NOW);
    // a gap: seq starts again at 1
    t = tapBatch(t, [ev(1, { event: "ping" })], { dropped: 0, gap: true }, NOW);
    expect(t.rows.map((r) => (r.kind === "event" ? `${r.event.event}#${r.event.seq}` : r.kind))).toEqual([
      "ping#1",
      "gap",
      "wave#5",
      "dropped",
      "wave#2",
      "wave#1",
    ]);
    expect(new Set(t.rows.map((r) => r.id)).size).toBe(t.rows.length);
    // an empty batch with a gap is a notice alone; an empty batch without one changes nothing
    expect(tapBatch(t, [], { dropped: 0, gap: true }, NOW).rows[0]!.kind).toBe("gap");
    expect(tapBatch(t, [], OK, NOW)).toBe(t);
  });

  test("paused, rows wait and are counted; resuming shows them on top; clearing hides what is shown", () => {
    let t = tapBatch(emptyTap, [ev(1)], OK, NOW);
    t = tapPaused(t, true);
    t = tapBatch(t, [ev(2), ev(3)], { dropped: 4, gap: false }, NOW);
    expect(t.rows).toHaveLength(1);
    // notices wait too, but only events are counted
    expect(tapWaiting(t)).toBe(2);
    t = tapCleared(t);
    expect(t.rows).toEqual([]);
    t = tapPaused(t, false);
    expect(t.rows.map((r) => (r.kind === "event" ? r.event.seq : r.kind))).toEqual([3, 2, "dropped"]);
    expect(tapWaiting(t)).toBe(0);
  });

  test("at most TAP_ROWS_MAX rows: the oldest go first", () => {
    const many = Array.from({ length: TAP_ROWS_MAX + 5 }, (_, i) => ev(i + 1));
    const t = tapBatch(emptyTap, many, OK, NOW);
    expect(t.rows).toHaveLength(TAP_ROWS_MAX);
    expect(t.rows[0]!.kind === "event" && t.rows[0]!.event.seq).toBe(TAP_ROWS_MAX + 5);
  });

  test("the filter matches the event's name in any case and keeps the notices", () => {
    const t = tapBatch(emptyTap, [ev(1), ev(2, { event: "Reaction" })], { dropped: 1, gap: false }, NOW);
    expect(tapFiltered(t.rows, "reac").map((r) => r.kind)).toEqual(["event", "dropped"]);
    expect(tapFiltered(t.rows, " ")).toHaveLength(3);
  });

  test("the test event's data: JSON (or the dashboard's syntax), a template from the payload's validator", () => {
    expect(parseEventData('{"x": 1}')).toEqual({ ok: true, data: { x: 1 } });
    expect(parseEventData("{ n: 5n }")).toEqual({ ok: true, data: { n: { $integer: "BQAAAAAAAAA=" } } });
    expect(parseEventData("")).toEqual({ ok: true, data: null });
    expect(parseEventData("{x:")).toEqual({ ok: false, error: "The data is not valid JSON: Expected a value (at 3)." });
    const payload = {
      type: "object" as const,
      value: { x: { fieldType: { type: "number" as const }, optional: false } },
    };
    expect(eventTemplate(payload)).toBe('{\n  "x": 0\n}');
    expect(eventTemplate(null)).toBe("{}");
  });
});

describe("the event tap", () => {
  test("shows each event as it passes: seq, time, event, sender, size and data; the data in full on a click", async () => {
    const { src } = mount(`/rooms?room=${encodeURIComponent(DOC)}`);
    const panel = await docPanel();
    await within(panel).findByText(/^Waiting for events/);
    const [ana] = (await src.listRoomMembers({ key: DOC }, { numItems: 1, cursor: null })).page;
    act(() => {
      src.rooms.emit(DOC, "reaction", { emoji: "🎉" }, ana!.memberId);
      src.rooms.emit(DOC, "ping", { at: 1 });
    });
    await waitFor(() => expect(tapRows(panel)).toHaveLength(2));
    const [ping, reaction] = tapRows(panel);
    expect(ping![0]).toBe("2");
    expect(ping![1]).toMatch(/^(\d{4}-\d\d-\d\d )?\d\d:\d\d:\d\d\.\d{3}$/);
    expect(ping!.slice(2)).toEqual(["ping", "server", "8 B", "{ at: 1 }"]);
    expect(reaction!.slice(0, 1)).toEqual(["1"]);
    expect(reaction!.slice(2, 4)).toEqual(["reaction", ana!.memberId]);
    expect(within(panel).getByText("2 events")).toBeDefined();
    await userEvent.setup().click(within(panel).getByText("reaction"));
    const details = within(panel).getByRole("article", { name: "Event 1" });
    expect(within(details).getByRole("figure", { name: "Data of event 1" }).textContent).toContain('emoji: "🎉"');
    await expectAccessible();
  });

  test("data over 16 KiB is said to be omitted, with its real size", async () => {
    const { src } = mount(`/rooms?room=${encodeURIComponent(DOC)}`);
    const panel = await docPanel();
    await within(panel).findByText(/^Waiting for events/);
    act(() => void src.rooms.emit(DOC, "big", { text: "x".repeat(20_000) }));
    await waitFor(() => expect(tapRows(panel)).toHaveLength(1));
    expect(tapRows(panel)[0]!.slice(4)).toEqual(["20 KB", OMITTED]);
    await userEvent.setup().click(within(panel).getByText("big"));
    expect(within(panel).getByText(/The data was not kept: its 20,011 bytes of JSON are over/)).toBeDefined();
  });

  test("dropped events and gaps are rows of their own", async () => {
    const src = source();
    let push: ((e: RoomEvent[], i: RoomEventsInfo) => void) | undefined;
    src.watchRoomEvents = (_room, onEvents) => {
      push = onEvents;
      return () => {};
    };
    mount(`/rooms?room=${encodeURIComponent(DOC)}`, src);
    const panel = await docPanel();
    await waitFor(() => expect(push).toBeDefined());
    act(() => push!([ev(7)], { dropped: 3, gap: false }));
    act(() => push!([], { dropped: 0, gap: true }));
    await waitFor(() => expect(tapRows(panel)).toHaveLength(3));
    const [gap, wave, dropped] = tapRows(panel);
    expect(gap![2]).toBe("gap");
    expect(gap![5]).toMatch(/^Gap: the tap lost track/);
    expect(wave![0]).toBe("7");
    expect(dropped![2]).toBe("dropped");
    expect(dropped![5]).toBe("Dropped 3 events: more than 200 arrived between two reads.");
    // the count is of events, not of notices
    expect(within(panel).getByText("1 event")).toBeDefined();
  });

  test("pause holds new events and counts them; resume shows them; clear empties the list; the filter", async () => {
    const { src } = mount(`/rooms?room=${encodeURIComponent(DOC)}`);
    const panel = await docPanel();
    await within(panel).findByText(/^Waiting for events/);
    const user = userEvent.setup();
    act(() => void src.rooms.emit(DOC, "ping", { at: 1 }));
    await waitFor(() => expect(tapRows(panel)).toHaveLength(1));
    await user.click(within(panel).getByRole("button", { name: /^Live\b/ }));
    expect(within(panel).getByText("Paused. Resume to see new events.")).toBeDefined();
    act(() => {
      src.rooms.emit(DOC, "wave", { x: 1, y: 1 });
      src.rooms.emit(DOC, "reaction", { emoji: "a" });
    });
    await within(panel).findByRole("button", { name: "Resume (2 new)" });
    expect(tapRows(panel)).toHaveLength(1);
    await user.click(within(panel).getByRole("button", { name: "Resume (2 new)" }));
    await waitFor(() => expect(tapRows(panel).map((r) => r[2])).toEqual(["reaction", "wave", "ping"]));
    await user.type(within(panel).getByRole("searchbox", { name: "Filter events by name" }), "WAV");
    expect(tapRows(panel).map((r) => r[2])).toEqual(["wave"]);
    expect(within(panel).getByText("1 of 3 events")).toBeDefined();
    await user.clear(within(panel).getByRole("searchbox", { name: "Filter events by name" }));
    await user.click(within(panel).getByRole("button", { name: "Clear" }));
    expect(tapRows(panel)).toEqual([]);
    // still live after a clear
    act(() => void src.rooms.emit(DOC, "ping", { at: 2 }));
    await waitFor(() => expect(tapRows(panel).map((r) => r[0])).toEqual(["4"]));
  });

  test("the tap stops when the panel closes, and is not started for a scope", async () => {
    const src = source();
    const started: string[] = [];
    let stopped = 0;
    const watch = src.watchRoomEvents.bind(src);
    src.watchRoomEvents = (room, onEvents, onError, onClosed) => {
      started.push(room.key);
      const off = watch(room, onEvents, onError, onClosed);
      return () => {
        stopped++;
        off();
      };
    };
    const { history } = mount(`/rooms?room=${encodeURIComponent(DOC)}`, src);
    const panel = await docPanel();
    await waitFor(() => expect(started).toEqual([DOC]));
    await userEvent.setup().click(within(panel).getByRole("button", { name: "Close the panel" }));
    await waitFor(() => expect(history.location.search).not.toContain("room="));
    expect(stopped).toBe(1);
    cleanup();
    mount(`/rooms?room=${encodeURIComponent(SCOPE)}`, src);
    const scope = await screen.findByRole("complementary", { name: "presence:online" });
    await waitFor(() => expect(members(scope).getAllByRole("listitem")).toHaveLength(3));
    expect(within(scope).queryByRole("region", { name: "Events" })).toBeNull();
    expect(started).toEqual([DOC]);
  });

  test("a terminal error is said, and the tap is over", async () => {
    const src = source();
    let fail: ((e: DataSourceErrorType) => void) | undefined;
    src.watchRoomEvents = (_room, _onEvents, onError) => {
      fail = onError;
      return () => {};
    };
    mount(`/rooms?room=${encodeURIComponent(DOC)}`, src);
    const panel = await docPanel();
    await waitFor(() => expect(fail).toBeDefined());
    act(() => fail!(new DataSourceError("unauthorized", "this credential cannot view the deployment's rooms")));
    const alert = await within(panel).findByRole("alert");
    expect(alert.textContent).toBe("The tap stopped: this credential cannot view the deployment's rooms");
    expect(within(panel).queryByRole("button", { name: /^Live\b/ })).toBeNull();
    expect(within(panel).getByText("No event passed through it while the tap was on.")).toBeDefined();
  });

  test("the room closing ends the tap, and the panel says the room closed without waiting for the list's poll", async () => {
    const src = source();
    let asked = 0;
    const listRooms = src.listRooms.bind(src);
    src.listRooms = (o) => {
      asked++;
      return listRooms(o);
    };
    mount(`/rooms?room=${encodeURIComponent(DOC)}`, src);
    const panel = await docPanel();
    await within(panel).findByText(/^Waiting for events/);
    act(() => void src.rooms.emit(DOC, "ping", { at: 1 }));
    await waitFor(() => expect(tapRows(panel)).toHaveLength(1));
    // right after a poll, so the next one is a second away
    const before = asked;
    await waitFor(() => expect(asked).toBeGreaterThan(before), { timeout: ROOMS_POLL_MS * 2 });
    const polled = asked;
    act(() => void src.rooms.close(DOC));
    await within(panel).findByText("The room closed: the tap ended.");
    // the tap's close asks the list at once
    await waitFor(() => expect(asked).toBeGreaterThan(polled), { timeout: ROOMS_POLL_MS / 3 });
    const status = await within(panel).findByRole("status");
    expect(status.textContent).toContain("Closed");
    // what it showed stays
    expect(tapRows(panel)).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the actions", () => {
  test("send a test event: confirmed, it reaches every member's client and the tap, from the server; audited", async () => {
    const { src } = mount(`/rooms?room=${encodeURIComponent(DOC)}`);
    const panel = await docPanel();
    await within(panel).findByText(/^Waiting for events/);
    const ids = (await src.listRoomMembers({ key: DOC }, { numItems: 10, cursor: null })).page.map((m) => m.memberId);
    const clients = ids.map((id) => src.rooms.client(DOC, id)!);
    const user = userEvent.setup();
    await user.click(within(panel).getByRole("button", { name: "Send test event" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Send a test event to rooms:doc?" });
    expect(dialog.textContent).toContain("It goes to its 5 members now, from the server");
    // the first declared event, its data box from the payload's validator
    const name = within(dialog).getByRole("combobox", { name: "Event" }) as HTMLInputElement;
    expect(name.value).toBe("ping");
    const data = within(dialog).getByRole("textbox", { name: "Data (JSON)" }) as HTMLTextAreaElement;
    expect(JSON.parse(data.value)).toEqual({ at: 0 });
    await user.clear(name);
    await user.type(name, "wave");
    expect(JSON.parse(data.value)).toEqual({ x: 0, y: 0 });
    await user.clear(data);
    await user.type(data, '{{"x": 3, "y": 4}');
    await expectAccessible(dialog);
    // nothing is sent before the confirm
    expect(clients[0]!.received).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Send event" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    for (const c of clients) expect(c.received).toEqual([{ event: "wave", from: null, data: { x: 3, y: 4 } }]);
    expect(within(panel).getByTestId("room-outcome").textContent).toBe("Sent wave to 5 members, from the server.");
    await waitFor(() => expect(tapRows(panel)).toHaveLength(1));
    expect(tapRows(panel)[0]!.slice(2, 4)).toEqual(["wave", "server"]);
    const audit = await src.listAuditEvents({ numItems: 5, cursor: null, actions: ["broadcast_room_event"] });
    expect(audit.page[0]!.metadata).toMatchObject({ room: "rooms:doc", args: '{"id":"design-review"}', event: "wave" });
  });

  test("what the server refuses is said in the dialog, which stays open; bad JSON never reaches it", async () => {
    const src = source();
    let sent = 0;
    const broadcast = src.broadcastRoomEvent.bind(src);
    src.broadcastRoomEvent = (...a) => {
      sent++;
      return broadcast(...a);
    };
    mount(`/rooms?room=${encodeURIComponent(DOC)}`, src);
    const panel = await docPanel();
    const user = userEvent.setup();
    await user.click(await within(panel).findByRole("button", { name: "Send test event" }));
    const dialog = await screen.findByRole("alertdialog");
    const name = within(dialog).getByRole("combobox", { name: "Event" });
    const data = within(dialog).getByRole("textbox", { name: "Data (JSON)" });
    const send = () => user.click(within(dialog).getByRole("button", { name: "Send event" }));
    // over the size limit: the server's words
    await user.clear(name);
    await user.type(name, "reaction");
    await user.clear(data);
    await user.click(data);
    await user.paste(`{"emoji": "${"x".repeat(5000)}"}`);
    await send();
    expect((await within(dialog).findByRole("alert")).textContent).toBe("The event is 5012 bytes (limit 4096).");
    // an event the room does not declare
    await user.clear(name);
    await user.type(name, "nope");
    await send();
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toBe('This room has no event "nope".'));
    // data its validator refuses
    await user.clear(name);
    await user.type(name, "ping");
    await user.clear(data);
    await user.type(data, '{{"at": "soon"}');
    await send();
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toMatch(/^ArgumentValidationError: /));
    expect(sent).toBe(3);
    // bad JSON: said here, not sent
    await user.clear(data);
    await user.type(data, "{{at:");
    await send();
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toMatch(/^The data is not valid JSON/));
    expect(sent).toBe(3);
    expect(screen.getByRole("alertdialog")).toBe(dialog);
    expect(within(panel).getByTestId("room-outcome").textContent).toBe("");
  });

  test("remove a member: the dialog says its connections and how it comes back; its client is ended", async () => {
    const { src } = mount(`/rooms?room=${encodeURIComponent(DOC)}`);
    const panel = await docPanel();
    await waitFor(() => expect(members(panel).getAllByRole("listitem")).toHaveLength(5));
    const first = members(panel).getAllByRole("listitem")[0]!;
    const id = first.getAttribute("aria-label")!.split(",")[0]!;
    const client = src.rooms.client(DOC, id)!;
    const user = userEvent.setup();
    await user.click(within(first).getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("alertdialog", { name: `Remove ${id} from rooms:doc?` });
    expect(dialog.textContent).toContain(
      `Its 1 connection ends now, and the others see it leave. This is not a ban: ${BACK_ONLY_IF}.`,
    );
    expect(client.ended).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(client.ended).toEqual({ code: "removed", message: "Removed from the dashboard." });
    expect(within(panel).getByTestId("room-outcome").textContent).toBe(`Removed ${id}: 1 connection ended.`);
    // asked again at once: the member is gone, the counts follow
    await waitFor(() => expect(members(panel).getAllByRole("listitem")).toHaveLength(4));
    await waitFor(() =>
      expect(within(panel).getByText("Members", { selector: "dt" }).nextSibling?.textContent).toBe("4"),
    );
    const audit = await src.listAuditEvents({ numItems: 5, cursor: null, actions: ["remove_room_member"] });
    expect(audit.page[0]!.metadata).toMatchObject({ room: "rooms:doc", member_id: id, connections: 1 });
  });

  test("a scope's user is removed with every tab; a member already gone is said so, not as an error", async () => {
    const { src } = mount(`/rooms?room=${encodeURIComponent(SCOPE)}`);
    const panel = await screen.findByRole("complementary", { name: "presence:online" });
    await waitFor(() => expect(members(panel).getAllByRole("listitem")).toHaveLength(3));
    const ana = members(panel).getByRole("listitem", { name: "user_ana" });
    const user = userEvent.setup();
    await user.click(within(ana).getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove user_ana from presence:online?" });
    expect(dialog.textContent).toContain("Their 2 tabs end now, and the others see them leave.");
    // it leaves before the confirm
    const { page } = await src.listRoomMembers({ key: SCOPE }, { numItems: 10, cursor: null });
    src.rooms.removeMember(SCOPE, page.find((m) => m.userId === "user_ana")!.memberId);
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(within(panel).getByTestId("room-outcome").textContent).toBe("user_ana had already left.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("close a room: the dialog says its members and connections; every client ends; the panel says it closed", async () => {
    const { src } = mount(`/rooms?room=${encodeURIComponent(DOC)}`);
    const panel = await docPanel();
    await waitFor(() => expect(members(panel).getAllByRole("listitem")).toHaveLength(5));
    const ids = members(panel)
      .getAllByRole("listitem")
      .map((li) => li.getAttribute("aria-label")!.split(",")[0]!);
    const clients = ids.map((id) => src.rooms.client(DOC, id)!);
    const user = userEvent.setup();
    await user.click(within(panel).getByRole("button", { name: "Close room" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Close rooms:doc?" });
    expect(dialog.textContent).toContain(
      `Its 5 members and their 5 connections end now, and the room closes. This is not a ban: ${BACK_ONLY_IF}.`,
    );
    await user.click(within(dialog).getByRole("button", { name: "Close room" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    for (const c of clients) expect(c.ended?.code).toBe("removed");
    expect(within(panel).getByTestId("room-outcome").textContent).toBe("Closed it: 5 members and 5 connections ended.");
    const status = await within(panel).findByRole("status");
    expect(status.textContent).toContain("Closed from the dashboard.");
    // a closed room has no actions
    expect(within(panel).queryByRole("button", { name: "Close room" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Remove" })).toBeNull();
    const audit = await src.listAuditEvents({ numItems: 5, cursor: null, actions: ["close_room"] });
    expect(audit.page[0]!.metadata).toMatchObject({ room: "rooms:doc", members: 5, connections: 5 });
  });

  test("a room already closed when confirmed is said so", async () => {
    const src = source();
    // the list keeps it open: the close lands between the list's polls
    const listRooms = src.listRooms.bind(src);
    let stale: Awaited<ReturnType<typeof listRooms>> | undefined;
    src.listRooms = async (o) => stale ?? listRooms(o);
    mount(`/rooms?room=${encodeURIComponent(DOC)}`, src);
    const panel = await docPanel();
    const user = userEvent.setup();
    await user.click(await within(panel).findByRole("button", { name: "Close room" }));
    const dialog = await screen.findByRole("alertdialog");
    stale = await listRooms();
    src.rooms.close(DOC);
    await user.click(within(dialog).getByRole("button", { name: "Close room" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(within(panel).getByTestId("room-outcome").textContent).toBe("It had already closed.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a read-only credential sees no action, and a note that says why; the tap still runs", async () => {
    const { src } = mount(
      `/rooms?room=${encodeURIComponent(DOC)}`,
      source({ capabilities: { operations: ["viewData", "viewMetrics", "writeData"], readOnly: true } }),
    );
    const panel = await docPanel();
    await waitFor(() => expect(members(panel).getAllByRole("listitem")).toHaveLength(5));
    expect(
      within(panel).getByText("Read-only: this credential cannot send events to rooms, remove members or close rooms."),
    ).toBeDefined();
    for (const name of ["Send test event", "Close room", "Remove"])
      expect(within(panel).queryByRole("button", { name })).toBeNull();
    await within(panel).findByText(/^Waiting for events/);
    act(() => void src.rooms.emit(DOC, "ping", { at: 1 }));
    await waitFor(() => expect(tapRows(panel)).toHaveLength(1));
    // and the source refuses it anyway
    const refused = await src.closeRoom({ key: DOC }).then(
      () => null,
      (e: DataSourceErrorType) => e,
    );
    expect(refused?.code).toBe("unauthorized");
  });

  test("a refusal the credential's capabilities did not foresee is said in the dialog", async () => {
    const src = source();
    src.closeRoom = () =>
      Promise.reject(new DataSourceError("unauthorized", "this credential cannot act on the deployment's rooms"));
    mount(`/rooms?room=${encodeURIComponent(DOC)}`, src);
    const panel = await docPanel();
    const user = userEvent.setup();
    await user.click(await within(panel).findByRole("button", { name: "Close room" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Close room" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "this credential cannot act on the deployment's rooms",
    );
  });
});
