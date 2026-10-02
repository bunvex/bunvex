import { describe, expect, test } from "bun:test";
import { Dashboard, type DashboardDataSource, type Topology } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import { attention, latest, maxSeries, recentMax, sumSeries, values } from "../src/screens/overview-data.ts";
import { expectAccessible } from "./axe.ts";

const source = (opts: Partial<ConstructorParameters<typeof MockDataSource>[0]> = {}) =>
  // the real clock: the metrics window is the last hour of it
  new MockDataSource({ seed: 4, now: Date.now(), executions: 80, topologyIntervalMs: 60_000, ...opts });

function mount(path: string, src: DashboardDataSource = source()) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={src} history={history} />);
  return { history };
}
const heading = () => screen.findByRole("heading", { level: 1, name: "Overview" });
const b = (time: number, value: number | null) => ({ time, value });

describe("the Overview's derivations", () => {
  test("sums and maxima per bucket; the latest bucket with a value; values without gaps", () => {
    const s = sumSeries([
      [b(1, 2), b(2, null), b(3, 1)],
      [b(1, 3), b(2, null), b(3, null)],
    ]);
    expect(s).toEqual([b(1, 5), b(2, null), b(3, 1)]);
    expect(maxSeries([[b(1, 2)], [b(1, 7)]])).toEqual([b(1, 7)]);
    expect(latest([b(1, 4), b(2, 9), b(3, null)])).toBe(9);
    expect(latest([b(1, null)])).toBeNull();
    expect(values(s)).toEqual([5, 1]);
    expect(sumSeries([])).toEqual([]);
    // the failure tile and "needs attention" read the same window: the last 5 minutes
    expect(recentMax([b(1, 90), b(2, 0), b(3, 0), b(4, 0), b(5, 0), b(6, 0)])).toBe(0);
    expect(recentMax([b(1, 0), b(2, 40), b(3, null), b(4, 0), b(5, 0), b(6, 0)])).toBe(40);
    expect(recentMax([b(1, null)])).toBeNull();
  });

  test("what needs attention: paused first, then nodes, store connections, failing functions, scheduler lag", () => {
    const t = (state: "ok" | "lagging" | "down", id: string) =>
      ({ id, role: "follower", state, lag: { commits: 3, ms: 840 } }) as unknown as Topology["nodes"][number];
    const items = attention({
      paused: true,
      topology: {
        nodes: [t("ok", "a"), t("lagging", "b"), t("down", "c")],
        store: { connections: { used: 90, max: 100 } },
      } as unknown as Topology,
      failures: [
        { function: "tasks:create", series: [b(1, 0), b(2, 60)] },
        { function: "tasks:list", series: [b(1, 0), b(2, 0)] },
        { function: "_rest", series: [b(1, 90)] },
      ],
      schedulerLag: [b(1, 2), b(2, 14)],
    });
    expect(items.map((i) => i.id)).toEqual([
      "paused",
      "down-c",
      "fail-tasks:create",
      "lag-b",
      "store-connections",
      "scheduler-lag",
    ]);
    expect(items.find((i) => i.id === "lag-b")!.text).toBe("b is behind the leader by 840 ms");
    expect(attention({})).toEqual([]);
  });
});

describe("the Overview screen (UI-01 §27)", () => {
  test("the deployment, the indicators, recent activity; the Engine section collapsed", async () => {
    const src = source();
    // a failed execution a minute ago, so recent activity has to place it before the older audit events
    const realLogs = src.listLogs.bind(src);
    src.listLogs = async (q, opts) => {
      const page = await realLogs(q, opts);
      const failed = {
        id: "failed-1",
        time: Date.now() - 60_000,
        level: "error" as const,
        message: "Uncaught Error: boom",
        function: { path: "tasks:create", kind: "mutation" as const },
        execution: { status: "failure" as const, durationMs: 4 },
      };
      return { ...page, page: [failed, ...page.page] };
    };
    mount("/", src);
    await heading();
    const summary = screen.getByRole("region", { name: "The deployment" });
    expect(within(summary).getByText("Deployment")).toBeDefined();
    // one row of four: both URLs in one cell, no lone wide cell (UX2-16)
    expect(
      within(summary)
        .getAllByRole("term")
        .map((t) => t.textContent),
    ).toEqual(["Deployment", "URLs", "Last deploy", "Nodes"]);
    await within(summary).findByText(/ago|yesterday|last/); // the last deploy, from the audit log
    const now = screen.getByRole("region", { name: "Now" });
    for (const label of ["Calls per minute", "Failure rate", "Latency p95", "Documents", "File storage"])
      expect(within(now).getByText(label)).toBeDefined();
    await waitFor(() => expect(within(now).getAllByRole("img").length).toBeGreaterThan(1)); // sparklines
    const activity = screen.getByRole("region", { name: "Recent activity" });
    await waitFor(() => expect(within(activity).getAllByRole("link").length).toBeGreaterThan(0));
    // newest first, the failed executions among the events
    const times = within(activity)
      .getAllByRole("listitem")
      .map((li) => Date.parse(li.querySelector("time")!.getAttribute("datetime")!));
    expect(times).toEqual([...times].sort((x, y) => y - x));
    expect(within(activity).getAllByRole("listitem")[0]!.textContent).toContain("Failed tasks:create");
    const engine = screen.getByText("Engine", { selector: "summary, summary *" }).closest("details")!;
    expect(engine.open).toBe(false);
    expect(screen.queryByRole("region", { name: "Commit timestamp" })).toBeNull();
    await expectAccessible();
  });

  test("a lagging follower and a paused deployment need attention, each linking where to look", async () => {
    const src = source({ nodes: 4 });
    const real = src.getTopology!.bind(src);
    src.getTopology = async (opts) => {
      const t = await real(opts);
      return { ...t, nodes: t.nodes.map((n, i) => (i === 2 ? { ...n, state: "lagging" as const } : n)) };
    };
    await src.pauseDeployment!();
    mount("/", src);
    await heading();
    const list = await screen.findByRole("list", { name: "Needs attention" });
    const paused = await within(list).findByRole("link", { name: /deployment is paused/ });
    expect(paused.getAttribute("href")).toBe("/settings/general");
    const lags = await within(list).findAllByRole("link", { name: /is behind the leader/ });
    expect(lags.every((l) => /^\/topology\?node=/.test(l.getAttribute("href")!))).toBe(true);
    expect(within(list).getAllByText(/^(Critical|Warning):$/).length).toBeGreaterThanOrEqual(2);
  });

  test("an empty deployment shows how to get started", async () => {
    mount("/", source({ tables: false }));
    await heading();
    const start = await screen.findByRole("region", { name: "Get started" });
    expect(within(start).getByRole("link", { name: "Database" }).getAttribute("href")).toBe("/database");
    expect(within(start).getByText(/BunvexClient/)).toBeDefined();
    // a finished step says so in words, not only in a lighter colour (UX2-26)
    expect(
      within(start)
        .getByText(/Functions deployed/)
        .closest("li")!.textContent,
    ).toContain("Done:");
  });

  test("/health, the old address, opens the Overview", async () => {
    const { history } = mount("/health");
    await heading();
    expect(history.location.pathname).toBe("/");
  });
});
