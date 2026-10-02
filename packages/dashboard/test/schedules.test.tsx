import { beforeEach, describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const mockSource = (over: Partial<ConstructorParameters<typeof MockDataSource>[0]> = {}) =>
  new MockDataSource({ seed: 7, now: NOW, executions: 20, documents: { tasks: 5, users: 5 }, ...over });

function mount(path: string, source = mockSource()) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={source} history={history} />);
  return { history, source };
}
const grid = (name: string) => screen.getByRole("grid", { name });
const rows = (name: string) => within(grid(name)).getAllByRole("row").slice(1);
const cells = (r: HTMLElement) =>
  within(r)
    .getAllByRole("gridcell")
    .map((c) => c.textContent ?? "");
const params = (h: ReturnType<typeof createMemoryHistory>) =>
  Object.fromEntries(new URLSearchParams(h.location.search));

beforeEach(() => localStorage.clear());

describe("the Schedules screen", () => {
  test("Schedules opens the scheduled functions: nearest first, with their state and function", async () => {
    const { history, source } = mount("/schedules");
    // the page's name in Bar 1; the screen's pages in its section column (UI-01 §23)
    await screen.findByRole("heading", { level: 1, name: "Scheduled functions" });
    const pages = screen.getByRole("navigation", { name: "Schedules" });
    expect(within(pages).getByRole("link", { name: "Scheduled functions" }).getAttribute("aria-current")).toBe("page");
    await waitFor(() => expect(history.location.pathname).toBe("/schedules/functions"));
    await waitFor(() => expect(rows("Scheduled functions").length).toBeGreaterThan(3));
    const all = (await source.listScheduledFunctions({ numItems: 100, cursor: null })).page;
    const shown = rows("Scheduled functions").map((r) => cells(r)[3]); // the grid renders what is in view
    expect(shown).toEqual(all.slice(0, shown.length).map((j) => j.id.slice(0, 8)));
    expect(cells(rows("Scheduled functions")[0]!)[1]).toBe("Running"); // the one due first has started
    expect(screen.getByRole("link", { name: "Scheduled functions" }).getAttribute("aria-current")).toBe("page");
    await expectAccessible();
  });

  test("the filter column: a function (by the source) and states (here), with their counts, in the URL", async () => {
    const { history, source } = mount("/schedules/functions");
    await waitFor(() => expect(rows("Scheduled functions").length).toBeGreaterThan(3));
    const all = (await source.listScheduledFunctions({ numItems: 100, cursor: null })).page;
    const fn = all[2]!.function;
    const column = screen.getByRole("navigation", { name: "Schedule filters" });
    const box = within(column).getByRole("checkbox", { name: fn });
    // the count of each function among the loaded runs, in text
    expect(box.closest("li")!.lastElementChild!.textContent).toBe(String(all.filter((r) => r.function === fn).length));
    const user = userEvent.setup();
    // functions are a multi-choice facet, as on Logs (UX2-23): "Only" picks one, the source filters by it
    await user.click(within(column).getByRole("button", { name: `Only ${fn}` }));
    await waitFor(() => expect(params(history)).toEqual({ function: fn }));
    await waitFor(() => expect(rows("Scheduled functions").every((r) => cells(r)[2]!.endsWith(fn))).toBe(true));
    // a second one: both, over the loaded runs
    const other = all.find((r) => r.function !== fn)!.function;
    await user.click(within(column).getByRole("checkbox", { name: other }));
    await waitFor(() => expect(params(history)).toEqual({ function: `${fn},${other}` }));
    await waitFor(() =>
      expect(rows("Scheduled functions").every((r) => [fn, other].some((f) => cells(r)[2]!.endsWith(f)))).toBe(true),
    );
    await user.click(within(column).getByRole("button", { name: "All: Function" }));
    await waitFor(() => expect(params(history)).toEqual({}));
    // states: keep the running ones only
    const pending = all.filter((r) => r.state === "pending").length;
    expect(within(column).getByRole("checkbox", { name: "Pending" }).closest("li")!.lastElementChild!.textContent).toBe(
      String(pending),
    );
    await user.click(within(column).getByRole("checkbox", { name: "Pending" }));
    await waitFor(() => expect(params(history)).toEqual({ state: "inProgress" }));
    await waitFor(() =>
      expect(screen.getByText(/^\d+ scheduled runs?$/).textContent).toBe(
        `${all.length - pending} scheduled ${all.length - pending === 1 ? "run" : "runs"}`,
      ),
    );
    await expectAccessible();
  });

  test("a run's details: arguments, and Cancel run after a confirmation", async () => {
    const { history, source } = mount("/schedules/functions");
    await waitFor(() => expect(rows("Scheduled functions").length).toBeGreaterThan(3));
    const pending = (await source.listScheduledFunctions({ numItems: 100, cursor: null })).page.find(
      (j) => j.state === "pending",
    )!;
    const user = userEvent.setup();
    const row = rows("Scheduled functions").find((r) => cells(r)[3] === pending.id.slice(0, 8))!;
    await user.click(within(row).getAllByRole("gridcell")[0]!);
    await waitFor(() => expect(params(history).run).toBe(pending.id));
    const panel = await screen.findByRole("complementary", { name: "Scheduled run" });
    expect(within(panel).getByText(pending.id)).toBeDefined();
    const [key] = Object.keys(pending.args);
    expect(within(panel).getByRole("region", { name: "Arguments" }).textContent).toContain(`${key}: `);
    await user.click(within(panel).getByRole("button", { name: "Cancel run" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Cancel this run?" });
    await expectAccessible(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Cancel run" }));
    await screen.findByText("Canceled the scheduled run.");
    await waitFor(() =>
      expect(rows("Scheduled functions").some((r) => cells(r)[3] === pending.id.slice(0, 8))).toBe(false),
    );
    expect(
      (await source.listScheduledFunctions({ numItems: 100, cursor: null })).page.some((j) => j.id === pending.id),
    ).toBe(false);
  });

  test("a running run cannot be canceled; one no longer scheduled says so", async () => {
    const { source } = mount("/schedules/functions");
    await waitFor(() => expect(rows("Scheduled functions").length).toBeGreaterThan(3));
    const running = (await source.listScheduledFunctions({ numItems: 100, cursor: null })).page.find(
      (j) => j.state === "inProgress",
    )!;
    const user = userEvent.setup();
    await user.click(within(rows("Scheduled functions")[0]!).getAllByRole("gridcell")[0]!);
    const panel = await screen.findByRole("complementary", { name: "Scheduled run" });
    expect(within(panel).getByText(running.id)).toBeDefined();
    expect(within(panel).getByRole("button", { name: "Cancel run" }).hasAttribute("disabled")).toBe(true);
    expect(within(panel).getByText("It has started: it can no longer be canceled.")).toBeDefined();
  });

  test("Cancel all runs of a function", async () => {
    const source = mockSource();
    const fn = (await source.listScheduledFunctions({ numItems: 100, cursor: null })).page.find(
      (j) => j.state === "pending",
    )!.function;
    mount(`/schedules/functions?function=${encodeURIComponent(fn)}`, source);
    await waitFor(() => expect(rows("Scheduled functions").length).toBeGreaterThan(0));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: `Cancel all runs of ${fn}` }));
    await user.click(await screen.findByRole("button", { name: "Cancel the runs" }));
    await screen.findByText(/^Canceled \d+ scheduled runs?\.$/);
    const left = (await source.listScheduledFunctions({ numItems: 100, cursor: null })).page;
    expect(left.filter((j) => j.function === fn).every((j) => j.state !== "pending")).toBe(true);
    expect(left.some((j) => j.function !== fn && j.state === "pending")).toBe(true); // only that function's
  });

  for (const [who, capabilities] of [
    ["a read-only credential", { operations: ["viewData", "writeData"], readOnly: true }],
    ["a credential without writeData", { operations: ["viewData"], readOnly: false }],
  ] as const)
    test(`${who} sees the runs but cannot cancel`, async () => {
      mount(
        "/schedules/functions",
        mockSource({ capabilities: { ...capabilities, operations: [...capabilities.operations] } }),
      );
      await waitFor(() => expect(rows("Scheduled functions").length).toBeGreaterThan(3));
      expect(screen.getByRole("button", { name: "Cancel all" }).hasAttribute("disabled")).toBe(true);
    });

  test("cron jobs: schedule, function, last and next run; a job's details list its recent runs", async () => {
    const { history } = mount("/schedules/functions");
    await screen.findByRole("heading", { level: 1, name: "Scheduled functions" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "Cron jobs" }));
    await screen.findByRole("heading", { level: 1, name: "Cron jobs" });
    // no filters on Cron jobs: the column holds only the pages
    expect(screen.queryByRole("navigation", { name: "Schedule filters" })).toBeNull();
    await waitFor(() => expect(history.location.pathname).toBe("/schedules/crons"));
    await waitFor(() => expect(rows("Cron jobs").length).toBe(4));
    const daily = rows("Cron jobs").find((r) => cells(r)[0] === "purge old messages")!;
    expect(cells(daily)[1]).toBe("Daily at 03:00 UTC");
    expect(cells(daily)[2]).toBe("messages:purgeOld");
    expect(cells(daily)[3]).toMatch(/^(Success|Failure)/);
    await user.click(within(daily).getAllByRole("gridcell")[0]!);
    await waitFor(() => expect(params(history)).toEqual({ cron: "purge old messages" }));
    const panel = await screen.findByRole("complementary", { name: "purge old messages" });
    const runs = await within(panel).findAllByRole("listitem");
    expect(runs.length).toBe(5);
    expect(within(panel).getByRole("region", { name: "Arguments" }).textContent).toContain("olderThanDays: 30");
    await expectAccessible();
  });

  test("a source without schedules says so", async () => {
    const source = mockSource();
    for (const m of ["listScheduledFunctions", "listCronJobs"] as const)
      Object.defineProperty(source, m, { value: undefined });
    mount("/schedules/functions", source);
    await screen.findByText("This deployment does not offer scheduled functions or cron jobs yet.");
  });
});
