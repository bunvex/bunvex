import { beforeEach, describe, expect, test } from "bun:test";
import { Dashboard, type LogEntry } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { interleave } from "../src/logs/events.ts";
import {
  ALL_LOGS,
  matchesLogView,
  readLogView,
  searchFromView,
  validateLogsSearch,
  viewFromSearch,
  writeLogView,
} from "../src/logs/log-filter.ts";
import { sumUsage } from "../src/logs/usage.ts";
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

describe("events among the lines", () => {
  test("placed by time, newest first; lines keep their order", () => {
    const at = (time: number, id: string) => ({ ...line({}), id, time });
    const ev = (time: number, id: string) => ({ id, time, action: "add_documents", author: null, metadata: {} });
    expect(
      interleave([at(50, "c"), at(30, "b"), at(10, "a")], [ev(60, "z"), ev(40, "y"), ev(5, "x")]).map((r) => r.id),
    ).toEqual(["event:z", "c", "event:y", "b", "a", "event:x"]);
    expect(interleave([at(1, "a")], [])).toEqual([at(1, "a")]);
  });
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
    // one request per mock execution; an action's calls are executions of their own, inside it
    const ends = history.filter((e) => e.execution && !e.parentExecutionId);
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

  test("a request that ran several functions shows them as a tree; the line's own execution is marked", async () => {
    const source = mount();
    await opened();
    const history = (await source.listLogs({ numItems: 200, cursor: null })).page;
    const child = history.find((e) => e.parentExecutionId && e.execution)!;
    expect(child).toBeDefined();
    // open the details of that child's last line
    const user = userEvent.setup();
    const at = rows().findIndex(
      (r) => cells(r)[COL.message] === child.message && cells(r)[COL.request] === child.requestId!.slice(0, 4),
    );
    await user.click(within(rows()[at]!).getAllByRole("gridcell")[COL.message]!);
    const calls = await screen.findByRole("region", { name: "Functions called" });
    // the outcome is this execution's, not the request's other calls'
    expect(screen.getByText(new RegExp(`^(Succeeded|Failed) in ${child.execution!.durationMs} ms$`))).toBeDefined();
    const items = within(calls).getAllByRole("listitem");
    const parent = history.find((e) => e.executionId === child.parentExecutionId)!;
    expect(items[0]!.textContent).toContain(parent.function!.path);
    const marked = calls.querySelector("[aria-current=true]")!;
    expect(marked.textContent).toContain(child.function!.path);
    expect(marked.textContent).toContain("this line");
    expect(within(calls).getAllByText(/^(Succeeded|Failed|Running):$/).length).toBe(items.length);
    await expectAccessible();
  });

  test("the deployment's events sit among the lines by time; filters leave them; Enter opens History", async () => {
    const source = mount(mockSource(), "/logs?type=failure");
    await screen.findByRole("heading", { level: 1, name: "Logs" });
    await source.insertDocuments("tasks", [{ text: "from the dashboard" }]);
    const event = await within(grid()).findByText("Added 1 document to tasks");
    const row = event.closest("tr") as HTMLElement;
    expect(cells(row)[COL.level]).toBe("event");
    expect(cells(row)[COL.function]).toBe("admin key");
    await expectAccessible();
    within(row).getAllByRole("gridcell")[0]!.focus();
    await userEvent.setup().keyboard("{Enter}");
    await waitFor(() => expect(lastHistory.location.pathname).toBe("/history"));
    expect(params().event).toBeDefined();
  });

  test("no events without an audit log this credential may read", async () => {
    const source = new MockDataSource({
      seed: 7,
      now: NOW,
      executions: 12,
      logIntervalMs: 3_600_000,
      capabilities: { operations: ["viewData", "writeData", "viewLogs"], readOnly: false },
    });
    mount(source);
    await opened();
    await source.insertDocuments("tasks", [{ text: "x" }]);
    await new Promise((r) => setTimeout(r, 50));
    expect(rows().some((r) => cells(r)[COL.level] === "event")).toBe(false);
  });

  test("a line's details say who started the request and the resources it used", async () => {
    mount();
    await opened();
    const user = userEvent.setup();
    // a line that ends an execution: it carries the usage and the identity
    const end = rows().find((r) => /^(success|failure)/.test(cells(r)[COL.outcome]!))!;
    await user.click(within(end).getAllByRole("gridcell")[COL.message]!);
    const panel = await screen.findByRole("complementary");
    expect(within(panel).getByText("Started by")).toBeDefined();
    const who = within(panel).getByText(/^(User|System)$/);
    // said once, the explanation as a tooltip; the kind as the list's badge (UX-24)
    expect(who.getAttribute("title")).toMatch(/^Started by /);
    expect(within(panel).queryByText(/^Started by (a|the) /)).toBeNull();
    expect(within(panel).getByTitle(/^(query|mutation|action)$/).textContent).toMatch(/^[QMA]$/);
    const used = within(panel).getByRole("region", { name: "Resources used" });
    expect(within(used).getByText(/^\d+ MB for \d+\.\d\d s$/)).toBeDefined();
    expect(within(used).getByText(/ read, .* written$/)).toBeDefined();
    await expectAccessible();
  });
});

describe("usage and identity", () => {
  test("the request's usage is summed over its executions; memory is the most one used", () => {
    const end = (id: string, durationMs: number, usage: object) =>
      ({ ...line({ id }), execution: { status: "success", durationMs, usage } }) as LogEntry;
    expect(
      sumUsage([
        end("1", 100, { memoryMb: 16, databaseReadBytes: 10, returnBytes: 5 }),
        line({ id: "2" }),
        end("3", 50, { memoryMb: 128, databaseReadBytes: 20 }),
      ]),
    ).toEqual({ executions: 2, runtimeMs: 150, memoryMb: 128, databaseReadBytes: 30, returnBytes: 5 });
    expect(sumUsage([line({})])).toBeNull();
  });

  test("the mock: a runner's run is an admin's, or an admin's acting as a user", async () => {
    const source = mockSource();
    const newestEnd = async () =>
      (await source.listLogs({ numItems: 20, cursor: null })).page.find((e) => e.execution)!.execution!;
    await source.runFunction("tasks:list", {});
    expect((await newestEnd()).identity).toBe("admin");
    await source.runFunction("tasks:list", {}, { identity: { subject: "u", issuer: "i" } });
    expect((await newestEnd()).identity).toBe("acting_as_user");
    expect((await newestEnd()).usage?.memoryMb).toBe(16);
  });

  test("the time stays in view when the list scrolls sideways (UX-5); on a phone the message comes second (UX-6)", async () => {
    mount();
    await opened();
    const header = (name: string) => within(grid()).getByRole("columnheader", { name });
    expect(header("Time").className).toContain("sticky");
    expect(within(rows()[0]!).getAllByRole("gridcell")[COL.time]!.className).toContain("sticky");
    cleanup();
    const real = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes("max-width: 639px"),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      mount();
      await opened();
      expect(
        within(grid())
          .getAllByRole("columnheader")
          .map((h) => h.textContent),
      ).toEqual(["Time", "Message", "Level", "Function", "Outcome", "Request"]);
    } finally {
      window.matchMedia = real;
    }
  });
});
