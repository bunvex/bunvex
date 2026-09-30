import { beforeEach, describe, expect, test } from "bun:test";
import { Dashboard, type LogEntry } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ALL_LOGS,
  matchesLogView,
  readLogView,
  searchFromView,
  validateLogsSearch,
  viewFromSearch,
  writeLogView,
} from "../src/logs/log-filter.ts";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const mockSource = () => new MockDataSource({ seed: 7, now: NOW, executions: 12, logIntervalMs: 3_600_000 });

function mount(source = mockSource(), path = "/logs") {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={source} history={history} />);
  lastHistory = history;
  return source;
}
let lastHistory: ReturnType<typeof createMemoryHistory>;
const params = () => Object.fromEntries(new URLSearchParams(lastHistory.location.search));
const grid = () => screen.getByRole("grid", { name: "Log lines" });
const rows = () => within(grid()).getAllByRole("row").slice(1);
const cells = (r: HTMLElement) =>
  within(r)
    .getAllByRole("gridcell")
    .map((c) => c.textContent ?? "");
const COL = { time: 0, request: 1, outcome: 2, level: 3, function: 4, message: 5 };
const opened = async () => {
  await screen.findByRole("heading", { level: 1, name: "Logs" });
  await waitFor(() => expect(rows().length).toBeGreaterThan(3));
};

beforeEach(() => localStorage.clear());

const line = (over: Partial<LogEntry>): LogEntry => ({
  id: "1",
  time: 0,
  level: "info",
  message: "task created",
  function: { path: "tasks:create", kind: "mutation" },
  requestId: "abcd1234",
  ...over,
});

describe("which lines a view keeps", () => {
  test("functions, types (a level, or the outcome on an execution's last line) and text", () => {
    const l = line({});
    expect(matchesLogView(l, ALL_LOGS)).toBe(true);
    expect(matchesLogView(l, { ...ALL_LOGS, functions: ["tasks:list"] })).toBe(false);
    expect(matchesLogView(l, { ...ALL_LOGS, functions: ["tasks:create"] })).toBe(true);
    expect(matchesLogView(l, { ...ALL_LOGS, types: ["error"] })).toBe(false);
    const failed = line({ execution: { status: "failure", durationMs: 3 } });
    expect(matchesLogView(failed, { ...ALL_LOGS, types: ["failure"] })).toBe(true);
    expect(matchesLogView(failed, { ...ALL_LOGS, types: ["success"] })).toBe(false);
    expect(matchesLogView(failed, { ...ALL_LOGS, types: ["info"] })).toBe(true); // its level
    for (const text of ["TASK CREATED", "tasks:cre", "abcd12"])
      expect(matchesLogView(l, { ...ALL_LOGS, text })).toBe(true);
    expect(matchesLogView(l, { ...ALL_LOGS, text: "nope" })).toBe(false);
  });

  test("a saved view is read back; a damaged one falls back to every line", () => {
    writeLogView("k", { functions: ["a:b"], types: ["warn"], text: "x" });
    expect(readLogView("k")).toEqual({ functions: ["a:b"], types: ["warn"], text: "x" });
    localStorage.setItem("k", "{not json");
    expect(readLogView("k")).toEqual(ALL_LOGS);
    localStorage.setItem("k", JSON.stringify({ functions: 3, types: ["loud", "error"] }));
    expect(readLogView("k")).toEqual({ functions: "all", types: ["error"], text: "" });
    writeLogView("k", ALL_LOGS); // the default is not stored
    expect(localStorage.getItem("k")).toBeNull();
  });

  test("a view in the URL: comma lists, `none` for an empty choice, unknown types dropped", () => {
    const v = { functions: ["tasks:list", "tasks:create"], types: ["failure" as const, "error" as const], text: "x" };
    expect(searchFromView(v)).toEqual({ function: "tasks:list,tasks:create", type: "failure,error", q: "x" });
    expect(viewFromSearch(validateLogsSearch(searchFromView(v)))).toEqual(v);
    expect(searchFromView({ ...ALL_LOGS, types: [] })).toEqual({ type: "none" });
    expect(viewFromSearch({ type: "none" })).toEqual({ ...ALL_LOGS, types: [] });
    expect(validateLogsSearch({ type: "loud,warn", q: "", function: 3 })).toEqual({ type: "warn" });
    expect(viewFromSearch({})).toBeNull();
  });
});

describe("the Logs screen", () => {
  test("every function's lines, newest first, with the execution's outcome on its last line", async () => {
    const source = mount();
    await opened();
    const history = (await source.listLogs({ numItems: 200, cursor: null })).page;
    expect(cells(rows()[0]!)[COL.message]).toBe(history[0]!.message);
    const times = rows().map((r) => cells(r)[COL.time]);
    expect([...times].sort().reverse()).toEqual(times);
    const ends = history.filter((e) => e.execution);
    expect(rows().some((r) => /^(success|failure) \d+ ms$/.test(cells(r)[COL.outcome]!))).toBe(true);
    expect(ends.length).toBe(12);
    await expectAccessible();
  });

  test("live: new lines arrive on top; paused, they wait and are counted until Resume", async () => {
    const source = mount();
    await opened();
    const user = userEvent.setup();
    let fresh: LogEntry[] = [];
    act(() => {
      fresh = source.logSomething();
    });
    await waitFor(() => expect(cells(rows()[0]!)[COL.message]).toBe(fresh.at(-1)!.message));
    await user.click(screen.getByRole("button", { name: "Pause" }));
    const top = cells(rows()[0]!);
    act(() => {
      fresh = source.logSomething();
    });
    const resume = await screen.findByRole("button", { name: `Resume (${fresh.length} new)` });
    expect(cells(rows()[0]!)).toEqual(top);
    await user.click(resume);
    await waitFor(() => expect(cells(rows()[0]!)[COL.message]).toBe(fresh.at(-1)!.message));
    expect(screen.getByRole("button", { name: "Pause" }).getAttribute("aria-pressed")).toBe("false");
  });

  test("a link with filters opens filtered, and becomes the view this browser keeps", async () => {
    const source = mockSource();
    mount(source, "/logs?type=failure");
    await screen.findByRole("heading", { level: 1, name: "Logs" });
    expect(screen.getByRole("button", { name: "Types: failure" })).toBeDefined();
    cleanup();
    mount(source);
    await screen.findByRole("heading", { level: 1, name: "Logs" });
    expect(screen.getByRole("button", { name: "Types: failure" })).toBeDefined();
    await waitFor(() => expect(params()).toEqual({ type: "failure" })); // the kept view goes into the address
  });

  test("an unknown type in the URL is dropped, from the screen and the address", async () => {
    mount(mockSource(), "/logs?type=loud");
    await opened();
    expect(screen.getByRole("button", { name: "Types: All types" })).toBeDefined();
    expect(params()).toEqual({});
  });

  test("picking a type is a step Back undoes; typing replaces the address", async () => {
    mount();
    await opened();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Types: All types" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "All types" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "failure" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(params()).toEqual({ type: "failure" }));
    const steps = lastHistory.length;
    await user.type(screen.getByRole("searchbox", { name: "Filter logs" }), "tasks");
    await waitFor(() => expect(params()).toEqual({ type: "failure", q: "tasks" }));
    expect(lastHistory.length).toBe(steps);
    act(() => lastHistory.back());
    await waitFor(() => expect(params()).toEqual({ type: "none" }));
    await screen.findByRole("button", { name: "Types: 0 types" }); // the screen follows the address back
  });

  test("filters: types and text apply to the loaded lines and are kept in this browser", async () => {
    const source = mount();
    await opened();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Types: All types" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "All types" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "success" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(rows().every((r) => cells(r)[COL.outcome]!.startsWith("success"))).toBe(true));
    expect(screen.getByRole("button", { name: "Types: success" })).toBeDefined();
    const fn = cells(rows()[0]!)[COL.function]!.slice(1); // after the kind's letter
    await user.type(screen.getByRole("searchbox", { name: "Filter logs" }), fn);
    await waitFor(() => expect(rows().every((r) => cells(r)[COL.function]!.endsWith(fn))).toBe(true));
    expect(screen.getByText(/of \d+ loaded lines match/)).toBeDefined();
    cleanup();
    mount(source);
    await screen.findByRole("heading", { level: 1, name: "Logs" });
    expect((screen.getByRole("searchbox", { name: "Filter logs" }) as HTMLInputElement).value).toBe(fn);
    expect(screen.getByRole("button", { name: "Types: success" })).toBeDefined();
  });

  test("Enter opens a line's details with its request; the details follow the arrows; Escape closes", async () => {
    mount();
    await opened();
    const user = userEvent.setup();
    await user.click(within(rows()[0]!).getAllByRole("gridcell")[COL.message]!);
    const panel = await screen.findByRole("complementary");
    const request = within(panel).getByRole("list");
    const first = cells(rows()[0]!);
    expect(within(panel).getByText(first[COL.message]!, { selector: "pre" })).toBeDefined();
    expect(within(request).getAllByRole("listitem").length).toBeGreaterThan(0);
    await user.keyboard("{ArrowDown}");
    const second = cells(rows()[1]!);
    await waitFor(() => expect(within(panel).getByText(second[COL.message]!, { selector: "pre" })).toBeDefined());
    await user.click(within(panel).getByRole("button", { name: "Filter by this request" }));
    const box = screen.getByRole("searchbox", { name: "Filter logs" }) as HTMLInputElement;
    expect(box.value).toHaveLength(16);
    await waitFor(() =>
      expect(new Set(rows().map((r) => cells(r)[COL.request]))).toEqual(new Set([box.value.slice(0, 4)])),
    );
    await expectAccessible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  test("Clear hides the loaded lines until they are asked for again", async () => {
    const source = mount();
    await opened();
    const user = userEvent.setup();
    const count = rows().length;
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(await screen.findByText("Waiting for new lines…")).toBeDefined();
    act(() => {
      source.logSomething();
    });
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: /^Show \d+ cleared$/ }));
    await waitFor(() => expect(rows().length).toBeGreaterThan(count - 1));
  });
});
