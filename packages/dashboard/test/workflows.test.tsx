import { describe, expect, test } from "bun:test";
import { Dashboard, type DashboardDataSource } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkflowStep } from "../src/extensions/workflows/data-source.ts";
import { layoutSteps } from "../src/extensions/workflows/diagram.tsx";
import { timelineScale } from "../src/extensions/workflows/run-view.tsx";
import { duration } from "../src/extensions/workflows/words.ts";
import { retryWords } from "../src/extensions/workflows/workpools.tsx";
import { fitOptions } from "../src/shell/flow-controls.tsx";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 9, 1, 12);
const source = (opts: Partial<ConstructorParameters<typeof MockDataSource>[0]> = {}) =>
  new MockDataSource({ seed: 3, now: NOW, executions: 20, ...opts });

function mount(path: string, src: DashboardDataSource = source()) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={src} history={history} />);
  return { history, src };
}
const params = (h: ReturnType<typeof createMemoryHistory>) =>
  Object.fromEntries(new URLSearchParams(h.location.search));

describe("workflows in words and places", () => {
  test("a run's steps laid out by group: a parallel group side by side, groups top to bottom", () => {
    const step = (index: number, group: number) => ({ index, group }) as WorkflowStep;
    const placed = layoutSteps([step(0, 0), step(1, 1), step(2, 1), step(3, 2)]);
    expect(placed.map((p) => p.y)).toEqual([0, 128, 128, 256]);
    expect(placed[1]!.x).toBeLessThan(placed[2]!.x);
    expect(placed[0]!.x).toBe(-110); // a lone step is centred
  });

  test("a workflow without parallel steps runs left to right, to use the width (UX2-14)", () => {
    const step = (index: number, group: number) => ({ index, group }) as WorkflowStep;
    const placed = layoutSteps([step(0, 0), step(1, 1), step(2, 2)]);
    expect(placed.map((p) => p.y)).toEqual([0, 0, 0]);
    expect(placed[0]!.x).toBeLessThan(placed[1]!.x);
    // and a small graph is shown readable: at least 85 %, up to 125 %; a big one never past 100 %
    expect(fitOptions(3, 0.15)).toEqual({ padding: 0.15, minZoom: 0.85, maxZoom: 1.25 });
    expect(fitOptions(12, 0.15)).toEqual({ padding: 0.15, maxZoom: 1 });
  });

  test("the timeline draws a long wait short, so the other steps keep their width (UX2-15)", () => {
    const h = 3_600_000;
    const run = { startedAt: 0 };
    // a step, a 7-hour wait for an event, then two more steps
    const steps = [
      { startedAt: 0, finishedAt: 60_000 },
      { startedAt: 7 * h, finishedAt: 7 * h + 120_000 },
      { startedAt: 7 * h + 120_000, finishedAt: 7 * h + 180_000 },
    ];
    const end = 7 * h + 180_000;
    const linear = timelineScale(run, steps, end, false);
    const cut = timelineScale(run, steps, end, true);
    expect(linear.breaks).toEqual([]);
    expect(cut.breaks).toHaveLength(1);
    expect(cut.breaks[0]!.ms).toBe(7 * h - 60_000);
    const width = (s: typeof linear, i: number) => s.at(steps[i]!.finishedAt) - s.at(steps[i]!.startedAt);
    expect(width(linear, 1)).toBeLessThan(0.01); // a tick, linearly
    expect(width(cut, 1)).toBeGreaterThan(0.2); // a real bar, with the wait cut
    expect(cut.at(end)).toBe(1);
  });

  test("durations and retry policies read as words", () => {
    expect([duration(40), duration(3200), duration(250_000), duration(3 * 86_400_000 + 7_200_000)]).toEqual([
      "40 ms",
      "3.2 s",
      "4 min 10 s",
      "3 d 2 h",
    ]);
    expect(
      retryWords({ retryByDefault: true, retry: { maxAttempts: 5, initialBackoffMs: 250, base: 2 } } as never),
    ).toBe("Actions retry by default: up to 5 tries, waiting 250 ms then ×2 each time");
  });
});

describe("the Workflows extension", () => {
  test("Runs: statuses as words; the status filter lives in the URL", async () => {
    const { history } = mount("/workflows/runs");
    await screen.findByRole("heading", { level: 1, name: "Runs" });
    const grid = await screen.findByRole("grid", { name: "Workflow runs" });
    await waitFor(() => expect(within(grid).getAllByRole("row").length).toBeGreaterThan(5));
    expect(within(grid).getAllByText("Succeeded").length).toBeGreaterThan(0);
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Failed" }));
    await waitFor(() => expect(params(history).status).toBe("failed"));
    await waitFor(() => {
      const statuses = within(grid)
        .getAllByRole("row")
        .slice(1)
        .map((r) => within(r).getAllByRole("gridcell")[1]!.textContent);
      expect(statuses.length > 0 && statuses.every((s) => s === "Failed")).toBe(true);
    });
    await expectAccessible();
  });

  test("a run: the timeline selects a step and opens its journal entry, with its arguments and error", async () => {
    const { history } = mount("/workflows/runs?status=failed");
    const grid = await screen.findByRole("grid", { name: "Workflow runs" });
    const user = userEvent.setup();
    await waitFor(() => expect(within(grid).getAllByRole("gridcell").length).toBeGreaterThan(0));
    await user.click(within(grid).getAllByRole("gridcell")[0]!);
    await waitFor(() => expect(params(history).run).toBeDefined());
    const journal = await screen.findByRole("region", { name: "Journal" });
    const timeline = screen.getByRole("region", { name: "Timeline" });
    const failed = within(journal)
      .getAllByRole("button")
      .findIndex((b) => b.textContent?.includes("Failed"));
    await user.click(within(timeline).getAllByRole("button")[failed]!);
    await waitFor(() => expect(params(history).step).toBe(String(failed)));
    expect(within(journal).getByRole("region", { name: `Outcome of step ${failed + 1}` }).textContent).toMatch(/Error/);
    expect(screen.getByRole("status").textContent).toMatch(/Error:/); // the run's error on top
    await expectAccessible();
  });

  test("Cancel a running run (confirmed); Rerun opens the new run", async () => {
    const { history, src } = mount("/workflows/runs?status=running");
    const grid = await screen.findByRole("grid", { name: "Workflow runs" });
    const user = userEvent.setup();
    await waitFor(() => expect(within(grid).getAllByRole("gridcell").length).toBeGreaterThan(0));
    await user.click(within(grid).getAllByRole("gridcell")[0]!);
    const id = await waitFor(() => params(history).run!);
    await user.click(await screen.findByRole("button", { name: "Cancel run" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Cancel this run?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel run" }));
    await waitFor(async () => expect((await src.getWorkflowRun!(id))!.run.status).toBe("canceled"));
    await user.click(await screen.findByRole("button", { name: "Rerun" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Rerun" }));
    await waitFor(() => expect(params(history).run).not.toBe(id));
    expect((await src.getWorkflowRun!(params(history).run!))!.run.status).toBe("running");
  });

  test("Work pools: parallelism in use, the retry policy in words, a chart per pool", async () => {
    mount("/workflows/workpools");
    const pool = await screen.findByRole("region", { name: "Pool llm" });
    expect(within(pool).getByText(/— full/)).toBeDefined();
    expect(within(pool).getByText(/up to 5 tries/)).toBeDefined();
    await expectAccessible();
  });

  test("read-only: no Cancel, Rerun or Restart", async () => {
    mount(
      "/workflows/runs?status=running",
      source({ capabilities: { operations: ["viewData", "viewLogs", "viewMetrics"], readOnly: true } }),
    );
    const grid = await screen.findByRole("grid", { name: "Workflow runs" });
    const user = userEvent.setup();
    await waitFor(() => expect(within(grid).getAllByRole("gridcell").length).toBeGreaterThan(0));
    await user.click(within(grid).getAllByRole("gridcell")[0]!);
    await screen.findByRole("region", { name: "Journal" });
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rerun" })).toBeNull();
  });
});
