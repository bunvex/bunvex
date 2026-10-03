// The Logs redesign (UI-01 §22.4): the filter column and its counts, the time range presets, the histogram
// and its window, Export, the details' time and raw JSON, the phone's Filters sheet.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Dashboard, type LogEntry } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { exportName, toJsonLines } from "../src/logs/export.ts";
import { bucketize, histogramDomain, outcomeOf, windowFromDrag } from "../src/logs/histogram-data.ts";
import { timeAgo } from "../src/logs/log-details.tsx";
import {
  ALL_LOGS,
  facetCounts,
  matchesLogView,
  searchFromView,
  timeBounds,
  validateLogsSearch,
  viewFromSearch,
} from "../src/logs/log-filter.ts";
import { expectAccessible } from "./axe.ts";

let history: ReturnType<typeof createMemoryHistory>;
function mount(source: MockDataSource, path = "/logs") {
  history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={source} history={history} />);
  return source;
}
// lines up to now (the presets count back from the real clock), one execution every ~3 minutes
const recent = (executions = 120) =>
  new MockDataSource({ seed: 7, now: Date.now(), executions, logIntervalMs: 3_600_000 });
const params = () => Object.fromEntries(new URLSearchParams(history.location.search));
const grid = (name = "Log lines") => screen.getByRole("grid", { name });
const rows = (name?: string) => within(grid(name)).getAllByRole("row").slice(1);
const timeOf = (r: HTMLElement) => within(r).getAllByRole("gridcell")[0]!.textContent ?? "";
/** How many lines the list shows, as the first bar says it (the grid draws only the rows in view). */
const shownCount = () => {
  const t = screen.getByText(/^[\d,]+ (of [\d,]+ )?lines?$/).textContent!;
  return Number(t.split(" ")[0]!.replaceAll(",", ""));
};
const opened = async () => {
  await screen.findByRole("heading", { level: 1, name: "Logs" });
  await waitFor(() => expect(rows().length).toBeGreaterThan(3));
};
/** The lines the screen has loaded: as many of the newest as its first bar counts. */
const loaded = async (source: MockDataSource) => {
  const t = screen.getByText(/^[\d,]+ (of [\d,]+ )?lines?$/).textContent!.split(" ");
  const total = Number((t[1] === "of" ? t[2] : t[0])!.replaceAll(",", ""));
  return (await source.listLogs({ numItems: total, cursor: null })).page;
};
const filters = () => screen.getByRole("navigation", { name: "Log filters" });
/** A choice's count, as its row says it. */
const countOf = (section: string, name: string) =>
  within(within(filters()).getByRole("region", { name: section }))
    .getByRole("checkbox", { name })
    .closest("li")!.lastElementChild!.textContent;

beforeEach(() => localStorage.clear());

const line = (over: Partial<LogEntry>): LogEntry => ({
  id: "1",
  time: 1_000,
  level: "info",
  message: "task created",
  function: { path: "tasks:create", kind: "mutation" },
  requestId: "abcd1234",
  ...over,
});

describe("the view's time and kinds", () => {
  test("a preset counts back from now; a window is its own bounds and overrides it", () => {
    expect(timeBounds(ALL_LOGS, 10_000_000)).toBeNull();
    expect(timeBounds({ ...ALL_LOGS, range: "5m" }, 10_000_000)).toEqual({ from: 9_700_000, to: 10_000_000 });
    const window = { from: 5, to: 9 };
    expect(timeBounds({ ...ALL_LOGS, range: "5m", window }, 10_000_000)).toEqual(window);
    const l = line({ time: 9_800_000 });
    expect(matchesLogView(l, { ...ALL_LOGS, range: "5m" }, 10_000_000)).toBe(true);
    expect(matchesLogView(l, { ...ALL_LOGS, range: "1m" }, 10_000_000)).toBe(false);
    expect(matchesLogView(l, { ...ALL_LOGS, kinds: ["mutation"] })).toBe(true);
    expect(matchesLogView(l, { ...ALL_LOGS, kinds: ["query", "action"] })).toBe(false);
  });

  test("counts per choice are taken under the time and the text, not under the other choices", () => {
    const lines = [
      line({ id: "1", time: 100 }),
      line({ id: "2", time: 200, level: "warn", function: { path: "tasks:list", kind: "query" } }),
      line({ id: "3", time: 300, execution: { status: "failure", durationMs: 2 } }),
      line({ id: "4", time: 5, message: "old" }),
    ];
    const c = facetCounts(lines, { ...ALL_LOGS, types: ["warn"], window: { from: 50, to: 400 } });
    expect(Object.fromEntries(c.functions)).toEqual({ "tasks:create": 2, "tasks:list": 1 });
    expect(Object.fromEntries(c.kinds)).toEqual({ mutation: 2, query: 1 });
    expect(Object.fromEntries(c.types)).toEqual({ info: 2, warn: 1, failure: 1 });
    const text = facetCounts(lines, { ...ALL_LOGS, text: "old" });
    expect(Object.fromEntries(text.types)).toEqual({ info: 1 });
  });

  test("in the URL: kind, range, and a window as from/to (a damaged window is dropped)", () => {
    const v = { ...ALL_LOGS, kinds: ["action" as const], range: "15m" as const };
    expect(searchFromView(v)).toEqual({ kind: "action", range: "15m" });
    expect(viewFromSearch(validateLogsSearch(searchFromView(v)))).toEqual(v);
    const w = { ...ALL_LOGS, window: { from: 100, to: 200 } };
    expect(searchFromView(w)).toEqual({ from: 100, to: 200 });
    expect(viewFromSearch(validateLogsSearch({ from: "100", to: "200" }))).toEqual(w);
    expect(validateLogsSearch({ from: 200, to: 100, range: "2d", kind: "http" })).toMatchObject({
      from: undefined,
      to: undefined,
      range: undefined,
      kind: undefined,
    });
  });
});

describe("the histogram's numbers", () => {
  test("outcomes: a failure or an error line, a warning, the rest", () => {
    expect(outcomeOf(line({}))).toBe("ok");
    expect(outcomeOf(line({ level: "warn" }))).toBe("warn");
    expect(outcomeOf(line({ level: "error" }))).toBe("error");
    expect(outcomeOf(line({ execution: { status: "failure", durationMs: 1 } }))).toBe("error");
  });

  test("buckets over the loaded span (at least a minute), to now; a preset's start widens it", () => {
    const lines = [line({ id: "3", time: 590_000, level: "warn" }), line({ id: "1", time: 500_000 })];
    const d = histogramDomain(lines, 600_000)!;
    expect(d).toEqual({ from: 500_000, to: 600_000 });
    expect(histogramDomain(lines, 600_000, 0)).toEqual({ from: 0, to: 600_000 });
    expect(histogramDomain([], 600_000)).toBeNull();
    expect(histogramDomain([line({ time: 599_000 })], 600_000)).toEqual({ from: 540_000, to: 600_000 });
    const b = bucketize(lines, d, 10);
    expect(b).toHaveLength(10);
    expect(b[0]).toMatchObject({ from: 500_000, to: 510_000, ok: 1, total: 1 });
    expect(b[9]).toMatchObject({ warn: 1, total: 1 });
    expect(b.reduce((n, x) => n + x.total, 0)).toBe(2);
  });

  test("a drag is a window between its ends, whichever way; a click is none", () => {
    const d = { from: 0, to: 1000 };
    expect(windowFromDrag(d, 0.8, 0.2)).toEqual({ from: 200, to: 800 });
    expect(windowFromDrag(d, -1, 2)).toEqual({ from: 0, to: 1000 });
    expect(windowFromDrag(d, 0.5, 0.501)).toBeNull();
  });
});

describe("the Logs screen's filter column", () => {
  test("labelled groups with the loaded lines' counts in text; a box filters the list and the URL", async () => {
    const source = mount(recent(40)); // one page: every line is loaded
    await opened();
    const all = await loaded(source);
    const counts = facetCounts(all, ALL_LOGS);
    expect(countOf("Type", "success")).toBe(String(counts.types.get("success")));
    expect(countOf("Function kind", "action")).toBe(String(counts.kinds.get("action")));
    const fn = [...counts.functions.keys()][0]!;
    expect(countOf("Functions", fn)).toBe(String(counts.functions.get(fn)));
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "query" }));
    await user.click(screen.getByRole("checkbox", { name: "mutation" }));
    await waitFor(() => expect(params()).toEqual({ kind: "action" }));
    const actions = all.filter((e) => e.function?.kind === "action").length;
    await waitFor(() => expect(shownCount()).toBe(actions));
    expect(screen.getByText(`${actions} of ${all.length} lines`)).toBeDefined();
    expect(rows().every((r) => within(r).getAllByRole("gridcell")[2]!.textContent!.startsWith("A"))).toBe(true);
    await expectAccessible();
  });

  test("a time range preset filters by the clock and goes into the URL; Reset puts everything back", async () => {
    const source = mount(recent());
    await opened();
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Last 15 minutes" }));
    await waitFor(() => expect(params()).toEqual({ range: "15m" }));
    const want = (await loaded(source)).filter((e) => matchesLogView(e, { ...ALL_LOGS, range: "15m" }));
    expect(want.length).toBeGreaterThan(0);
    await waitFor(() => expect(shownCount()).toBe(want.length));
    // the strip names the range it shows
    expect(
      within(screen.getByRole("region", { name: "Log volume over time" })).getByText("Last 15 minutes"),
    ).toBeDefined();
    await user.click(within(filters()).getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(params()).toEqual({}));
    expect((screen.getByRole("radio", { name: "All time" }) as HTMLInputElement).checked).toBe(true);
  });

  test("a range older than the loaded lines loads older pages (STUDY-12 L4)", async () => {
    // one execution every ~27 s: the first page is about half an hour
    const source = mount(recent(800));
    await opened();
    const first = await loaded(source);
    const hour = Date.now() - 3_600_000;
    expect(first.at(-1)!.time).toBeGreaterThan(hour);
    act(() => history.push("/logs?range=1h"));
    const everything = (await source.listLogs({ numItems: 5000, cursor: null })).page;
    const want = everything.filter((e) => e.time >= hour + 5_000).length;
    await waitFor(() => expect(shownCount()).toBeGreaterThanOrEqual(want), { timeout: 4000 });
  });
});

describe("the histogram", () => {
  test("stacked columns with a legend in words; the keyboard picks a window that filters and goes into the URL", async () => {
    mount(recent(40));
    await opened();
    const strip = screen.getByRole("region", { name: "Log volume over time" });
    const legend = within(strip).getByRole("list", { name: "Legend" });
    expect(
      within(legend)
        .getAllByRole("listitem")
        .map((l) => l.textContent?.replace(/[\d,]+$/, "")),
    ).toEqual(["Success", "Warning", "Failure"]);
    // the table for assistive tech holds every counted line
    const table = within(strip).getByRole("table");
    const sum = within(table)
      .getAllByRole("row")
      .slice(1)
      .flatMap((r) =>
        within(r)
          .getAllByRole("cell")
          .map((c) => Number(c.textContent)),
      )
      .reduce((a, b) => a + b, 0);
    expect(sum).toBe(shownCount());
    expect(strip.querySelectorAll('[data-outcome="ok"]').length).toBeGreaterThan(0);

    const plot = within(strip).getByRole("application", { name: "Log lines per time bucket" });
    plot.focus();
    const user = userEvent.setup();
    await user.keyboard("{End}{Shift>}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{/Shift}");
    expect(within(strip).getByRole("tooltip").textContent).toMatch(/\d\d:\d\d:\d\d – \d\d:\d\d:\d\d/);
    const before = shownCount();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(Object.keys(params()).sort()).toEqual(["from", "to"]));
    const { from, to } = params();
    await waitFor(() => expect(shownCount()).toBeLessThan(before));
    expect(strip.textContent).toMatch(/Window \d\d:\d\d:\d\d – \d\d:\d\d:\d\d/);
    expect(Number(to) - Number(from)).toBeGreaterThan(0);
    // the window is the URL's: Back undoes it; Clear selection drops it
    await user.click(within(strip).getByRole("button", { name: "Clear selection" }));
    await waitFor(() => expect(params()).toEqual({}));
    await waitFor(() => expect(shownCount()).toBe(before));
  });

  test("dragging across the strip picks the window between the drag's ends", async () => {
    mount(recent());
    await opened();
    const plot = screen.getByRole("application", { name: "Log lines per time bucket" });
    plot.getBoundingClientRect = () => ({ left: 0, width: 600, top: 0, height: 56 }) as DOMRect;
    fireEvent.pointerDown(plot, { clientX: 300, button: 0 });
    fireEvent.pointerMove(plot, { clientX: 600 });
    fireEvent.pointerUp(plot, { clientX: 600 });
    await waitFor(() => expect(Object.keys(params()).sort()).toEqual(["from", "to"]));
    const from = Number(params().from);
    const shown = rows().map(timeOf);
    expect(shown.length).toBeGreaterThan(0);
    // every shown line is in the later half: compared as instants, since a line's time is "HH:mm:ss.SSS" today
    // and "YYYY-MM-DD HH:mm:ss.SSS" before (shell/time.tsx), so its text does not sort against a date
    const instant = (t: string) => {
      const today = new Date();
      const [date, clock] = t.includes(" ")
        ? (t.split(" ") as [string, string])
        : [`${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`, t];
      const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
      const [h, mi, s] = clock.split(":").map(Number) as [number, number, number];
      return new Date(y, mo - 1, d, h, mi, Math.floor(s), Math.round((s % 1) * 1000)).getTime();
    };
    expect(shown.filter((t) => instant(t) < from)).toEqual([]);
  });
});

describe("Export", () => {
  test("JSON Lines, oldest first, one object per line; named by the time", () => {
    const a = line({ id: "1", time: 1 });
    const b = line({ id: "2", time: 2, message: 'say "hi"\nthere' });
    const text = toJsonLines([b, a]);
    expect(text.split("\n")).toHaveLength(3);
    expect(
      text
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l)),
    ).toEqual([a, b]);
    expect(exportName("logs", Date.UTC(2026, 9, 1, 12, 4, 5))).toBe("logs-2026-10-01T12-04-05.jsonl");
  });

  const real = { create: URL.createObjectURL, click: HTMLAnchorElement.prototype.click };
  afterEach(() => {
    URL.createObjectURL = real.create;
    HTMLAnchorElement.prototype.click = real.click;
  });

  test("the button saves the shown lines", async () => {
    const source = mount(recent(), "/logs?kind=query");
    await opened();
    const blobs: Blob[] = [];
    const names: string[] = [];
    URL.createObjectURL = ((b: Blob) => {
      blobs.push(b);
      return "blob:x";
    }) as typeof URL.createObjectURL;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      names.push(this.download);
    };
    await userEvent.setup().click(screen.getByRole("button", { name: "Export" }));
    expect(names[0]).toMatch(/^logs-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.jsonl$/);
    const lines = (await blobs[0]!.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as LogEntry);
    const queries = (await loaded(source)).filter((e) => e.function?.kind === "query");
    expect(lines.length).toBe(queries.length);
    expect(lines.every((e) => e.function?.kind === "query")).toBe(true);
    expect(lines[0]!.time).toBeLessThanOrEqual(lines.at(-1)!.time);
  });
});

describe("a line's details", () => {
  test("open on a line only: its time (ISO, local, relative), level, request, message and raw JSON", async () => {
    const source = mount(recent());
    await opened();
    expect(screen.queryByRole("complementary")).toBeNull();
    const top = (await loaded(source))[0]!;
    await userEvent.setup().click(within(rows()[0]!).getAllByRole("gridcell")[5]!);
    const panel = await screen.findByRole("complementary");
    const iso = new Date(top.time).toISOString();
    expect(within(panel).getByText(iso).tagName).toBe("TIME");
    expect(
      within(panel).getByText(new RegExp(`${timeAgo(top.time, Date.now()).replace(/\d+/, "\\d+")}$`)),
    ).toBeDefined();
    expect(within(panel).getByText("Level")).toBeDefined();
    const raw = within(panel).getByRole("figure", { name: "This line as JSON" });
    expect(raw.textContent).toContain(`"id": "${top.id}"`);
    expect(raw.textContent).toContain(`"message": ${JSON.stringify(top.message)}`);
    await expectAccessible();
  });

  test("relative time in words", () => {
    expect(timeAgo(1_000, 59_000)).toBe("58 seconds ago");
    expect(timeAgo(0, 180_000)).toBe("3 minutes ago");
    expect(timeAgo(0, 0)).toBe("now");
    expect(timeAgo(0, 7_200_000)).toBe("2 hours ago");
  });
});

describe("one function's logs", () => {
  test("a range in the URL opens the Logs tab with it; the same strip, no functions or kinds", async () => {
    mount(recent(), "/functions?function=tasks:list&range=1h");
    await screen.findByRole("heading", { level: 1, name: "list" });
    expect(screen.getByRole("tab", { name: "Logs" }).getAttribute("aria-selected")).toBe("true");
    expect((screen.getByRole("radio", { name: "Last hour" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("region", { name: "Log volume over time" })).toBeDefined();
    expect(screen.queryByRole("checkbox", { name: "query" })).toBeNull();
    await userEvent.setup().click(screen.getByRole("radio", { name: "Last 5 minutes" }));
    await waitFor(() => expect(params()).toEqual({ function: "tasks:list", range: "5m", tab: "logs" }));
  });
});

describe("on a phone", () => {
  test("Filters opens the same sections in a sheet", async () => {
    mount(recent());
    await opened();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Filters" }));
    const sheet = await screen.findByRole("complementary");
    expect(within(sheet).getByRole("region", { name: "Time range" })).toBeDefined();
    await user.click(within(sheet).getByRole("checkbox", { name: "warn" }));
    await waitFor(() => expect(params().type).toBe("success,failure,debug,info,error"));
    await user.click(within(sheet).getByRole("button", { name: "Reset filters" }));
    await waitFor(() => expect(params()).toEqual({}));
  });
});
