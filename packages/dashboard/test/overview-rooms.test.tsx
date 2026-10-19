// The rooms' counters on the Overview (AD-43, STUDY-165 §3.2): a collapsed Rooms section only for stats that carry
// `rooms`, its gauges as they are, its counters with their rate between two samples, read every second while open.
import { afterEach, describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import type { DeploymentStats, RoomStats } from "@bunvex/dashboard/data-source";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ROOMS_POLL_MS } from "../src/rooms/words.ts";
import { roomDelta, roomRate } from "../src/screens/room-stats.ts";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 9, 18, 12);
const source = () =>
  new MockDataSource({ seed: 4, now: NOW, executions: 3, logIntervalMs: 3_600_000, statsIntervalMs: 200 });

function mount(src = source()) {
  render(<Dashboard dataSource={src} history={createMemoryHistory({ initialEntries: ["/"] })} />);
  return src;
}

afterEach(cleanup);

const ROOMS: RoomStats = {
  rooms: 2,
  members: 8,
  connections: 9,
  joins: 10,
  joinsRefusedByGate: 0,
  joinsRefusedByLimit: 0,
  leaves: 2,
  graceExpiries: 0,
  presenceAccepted: 100,
  presenceDropped: 1,
  eventsAccepted: 5,
  eventsDropped: 0,
  resyncs: 0,
  roomLeft: 0,
};
const sample = (at: number, rooms?: Partial<RoomStats>): DeploymentStats =>
  ({ at, commitTs: 1, rooms: rooms && { ...ROOMS, ...rooms } }) as DeploymentStats;

describe("the rooms' rates", () => {
  test("per second between two samples; 0 without rooms, without time, or when a counter went back", () => {
    expect(roomRate(sample(0), sample(2000, { presenceAccepted: 300 }), "presenceAccepted")).toBe(0);
    expect(roomRate(sample(0, {}), sample(2000, { presenceAccepted: 300 }), "presenceAccepted")).toBe(100);
    expect(roomRate(sample(0, {}), sample(0, { joins: 20 }), "joins")).toBe(0);
    // a restart: the counters start again from zero
    expect(roomRate(sample(0, {}), sample(1000, { joins: 3 }), "joins")).toBe(0);
    expect(roomDelta(undefined, sample(0, {}), "eventsDropped")).toBe(0);
    expect(roomDelta(sample(0, {}), sample(1000, { eventsDropped: 4 }), "eventsDropped")).toBe(4);
    expect(roomDelta(sample(0, { eventsDropped: 4 }), sample(1000, { eventsDropped: 1 }), "eventsDropped")).toBe(0);
  });
});

describe("the Overview's Rooms section", () => {
  test("collapsed, with the gauges on its line; open: the gauges and the counters with their rates", async () => {
    mount();
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    const summary = await screen.findByText(/— 2 open, 8 members, 9 connections/);
    await userEvent.setup().click(summary);
    const counters = await screen.findByRole("region", { name: "Rooms now, and counters since the server started" });
    const value = (label: string) => within(counters).getByText(label).nextSibling?.textContent;
    expect([value("Open rooms"), value("Members"), value("Connections")]).toEqual(["2", "8", "9"]);
    expect(value("Presence updates")).toMatch(/^[\d,]+$/);
    // a rate once a second sample came
    await waitFor(
      () => expect(within(counters).getByText("Presence updates").parentElement?.textContent).toMatch(/[\d.]+\/s/),
      { timeout: ROOMS_POLL_MS * 4 },
    );
    expect(within(counters).getByText(/refused: \d+ by a gate, \d+ by a limit/)).toBeDefined();
    expect(screen.getByRole("link", { name: "See the open rooms" }).getAttribute("href")).toBe("/rooms");
    await expectAccessible();
  });

  test("a closed room's members leave the gauges", async () => {
    const src = mount();
    await screen.findByText(/— 2 open, 8 members, 9 connections/);
    src.rooms.close(`room|rooms:doc|{"id":"design-review"}`);
    expect(await screen.findByText(/— 1 open, 3 members, 4 connections/, {}, { timeout: 2000 })).toBeDefined();
  });

  test("stats without rooms: no section", async () => {
    const src = source();
    const getStats = src.getStats.bind(src);
    const watchStats = src.watchStats.bind(src);
    const strip = ({ rooms: _, ...s }: DeploymentStats) => s;
    src.getStats = async (o) => strip(await getStats(o));
    src.watchStats = (on, err) => watchStats((s) => on(strip(s)), err);
    mount(src);
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    await screen.findByText(/Engine/);
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByText(/ open, [\d,]+ members, /)).toBeNull();
  });

  test("read every second while open, not while collapsed", async () => {
    const src = source();
    let asked = 0;
    const getStats = src.getStats.bind(src);
    src.getStats = (o) => {
      asked++;
      return getStats(o);
    };
    mount(src);
    const summary = await screen.findByText(/— 2 open, 8 members, 9 connections/);
    await new Promise((r) => setTimeout(r, ROOMS_POLL_MS + 200));
    // the Overview's other reads do not use getStats on the mock (its samples come from watchStats)
    const closed = asked;
    await userEvent.setup().click(summary);
    await screen.findByRole("region", { name: "Rooms now, and counters since the server started" });
    const start = asked;
    expect(start).toBeGreaterThan(closed);
    await new Promise((r) => setTimeout(r, ROOMS_POLL_MS * 2 + 300));
    expect(asked - start).toBeGreaterThanOrEqual(2);
    expect(asked - start).toBeLessThanOrEqual(3);
  });
});
