import { describe, expect, test } from "bun:test";
import { Dashboard, REST } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { lastHour, topSeries } from "../src/metrics/metrics.ts";
import { executionsOf } from "../src/mock/metrics.ts";
import { expectAccessible } from "./axe.ts";

// the mock's history ends now, so the last hour has data
const source = (opts: Partial<ConstructorParameters<typeof MockDataSource>[0]> = {}) =>
  new MockDataSource({ seed: 3, executions: 600, ...opts });

function mount(src: MockDataSource = source()) {
  render(<Dashboard dataSource={src} history={createMemoryHistory({ initialEntries: ["/"] })} />);
}

describe("the mock's metrics, from its log history", () => {
  test("calls add up to the executions in the window; the rest folds into _rest", async () => {
    const src = source();
    const w = lastHour();
    const top = await src.topFunctions("invocations", w, 3);
    const total = top.reduce((n, t) => n + t.series.reduce((m, b) => m + (b.value ?? 0), 0), 0);
    const logs = (await src.listLogs({ numItems: 100_000, cursor: null })).page;
    expect(total).toBe(executionsOf(logs).filter((x) => x.time >= w.start && x.time < w.end).length);
    expect(top.filter((t) => t.function !== REST)).toHaveLength(3);
    expect(top.at(-1)!.function).toBe(REST);
  });

  test("only queries hit the cache; percentiles never decrease", async () => {
    const src = source();
    const w = lastHour();
    const mutation = (await src.listFunctions()).find((f) => f.kind === "mutation")!.path;
    const hits = await src.functionRate(mutation, "cacheHits", w);
    expect(hits.every((b) => b.value === 0)).toBe(true);
    const query = (await src.listFunctions()).find((f) => f.kind === "query")!.path;
    const [p50, p99] = await src.latencyPercentiles(query, [50, 99], w);
    p50!.series.forEach((b, i) => {
      if (b.value !== null) expect(p99!.series[i]!.value!).toBeGreaterThanOrEqual(b.value);
    });
  });

  test("a function keeps its colour whatever its rank; the rest is grey", () => {
    const s = (fn: string) => ({ function: fn, series: [] });
    const a = topSeries([s("b:x"), s("a:y"), s(REST)]);
    const b = topSeries([s("a:y"), s("b:x"), s(REST)]);
    const color = (xs: typeof a, id: string) => xs.find((x) => x.id === id)!.color;
    expect(color(a, "a:y")).toBe(color(b, "a:y"));
    expect(color(a, "b:x")).toBe(color(b, "b:x"));
    expect(color(a, "a:y")).not.toBe(color(a, "b:x"));
    expect(color(a, REST)).toBe("series-other");
    // a function joining the top does not repaint the others
    const before = topSeries([s("users:get"), s("messages:send")]);
    const after = topSeries([s("tasks:list"), s("users:get"), s("messages:send")]);
    expect(color(after, "users:get")).toBe(color(before, "users:get"));
    expect(color(after, "messages:send")).toBe(color(before, "messages:send"));
    expect(a.find((x) => x.id === REST)!.label).toBe("Other functions");
  });
});

describe("Health: the last hour's function metrics", () => {
  test("calls, failure rate, cache hit rate and scheduler lag, each a chart with its legend", async () => {
    mount();
    const section = await screen.findByRole("region", { name: "Functions, last hour" });
    for (const name of ["Function calls", "Failure rate", "Cache hit rate", "Scheduler lag"])
      expect(within(section).getByRole("region", { name })).toBeDefined();
    const calls = within(section).getByRole("region", { name: "Function calls" });
    const figure = await within(calls).findByRole("figure");
    expect(figure.getAttribute("aria-label")).toBe("Function calls, Calls per minute, top 5");
    const legend = within(calls).getByRole("list");
    expect(within(legend).getAllByRole("listitem").at(-1)!.textContent).toBe("Other functions");
    await expectAccessible();
  });

  test("a credential that may not view metrics is told so", async () => {
    mount(source({ capabilities: { operations: ["viewData", "viewLogs"], readOnly: true } }));
    const section = await screen.findByRole("region", { name: "Functions, last hour" });
    expect(within(section).getByText("This credential may not view metrics.")).toBeDefined();
    expect(within(section).queryByRole("figure")).toBeNull();
  });

  test("a source without metrics says the deployment does not report them", async () => {
    const src = source();
    (src as { topFunctions?: unknown }).topFunctions = undefined;
    mount(src);
    expect(await screen.findByText("This deployment does not report metrics.")).toBeDefined();
  });
});

describe("Functions: a function's Statistics tab", () => {
  const open = (path: string, src: MockDataSource = source()) => {
    const history = createMemoryHistory({ initialEntries: [path] });
    render(<Dashboard dataSource={src} history={history} />);
    return history;
  };

  test("a query: calls, errors, execution time percentiles labelled at their ends, cache hit rate", async () => {
    open("/functions?function=tasks:list");
    const panel = await screen.findByRole("tabpanel", { name: "Statistics" });
    const charts = await within(panel).findAllByRole("region");
    expect(charts.map((c) => c.getAttribute("aria-labelledby") && c.querySelector("h3")?.textContent)).toEqual([
      "Function calls",
      "Errors",
      "Execution time",
      "Cache hit rate",
    ]);
    const latency = within(panel).getByRole("region", { name: "Execution time" });
    await within(latency).findByRole("figure");
    const labels = [...latency.querySelectorAll("svg text")].map((t) => t.textContent);
    for (const p of ["p50", "p90", "p95", "p99"]) expect(labels).toContain(p);
    await expectAccessible();
  });

  test("a mutation has no cache hit rate", async () => {
    open("/functions?function=tasks:create");
    const panel = await screen.findByRole("tabpanel", { name: "Statistics" });
    await within(panel).findByRole("region", { name: "Errors" });
    expect(within(panel).queryByRole("region", { name: "Cache hit rate" })).toBeNull();
  });

  test("a credential that may not view metrics is told so on the tab", async () => {
    open(
      "/functions?function=tasks:list",
      source({ capabilities: { operations: ["viewData", "viewLogs"], readOnly: true } }),
    );
    const panel = await screen.findByRole("tabpanel", { name: "Statistics" });
    expect(await within(panel).findByText("This credential may not view metrics.")).toBeDefined();
  });

  test("the tab is in the URL; a link with log filters opens the logs", async () => {
    const history = open("/functions?function=tasks:list&type=failure");
    expect((await screen.findByRole("tab", { name: "Logs" })).getAttribute("aria-selected")).toBe("true");
    await userEvent.setup().click(screen.getByRole("tab", { name: "Statistics" }));
    expect(new URLSearchParams(history.location.search).get("tab")).toBe("statistics");
    expect(new URLSearchParams(history.location.search).get("type")).toBe("failure"); // the filters stay
  });
});
