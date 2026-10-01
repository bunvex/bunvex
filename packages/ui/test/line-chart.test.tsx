import { describe, expect, test } from "bun:test";
import { type ChartSeries, LineChart, niceTicks } from "@bunvex/ui/components/line-chart";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expectAccessible } from "./axe.ts";

const T0 = Date.UTC(2026, 8, 30, 12);
const pts = (...vs: (number | null)[]) => vs.map((value, i) => ({ time: T0 + i * 60_000, value }));
const fmtTime = (t: number) => `m${(t - T0) / 60_000}`;
const two: ChartSeries[] = [
  { id: "a", label: "tasks:list", points: pts(1, 2, null, 4), color: "series-1" },
  { id: "b", label: "Other functions", points: pts(3, 1, 0, 2), color: "series-other" },
];

describe("LineChart", () => {
  test("round ticks from zero", () => {
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(100)).toEqual([0, 50, 100]);
    expect(niceTicks(0.9)).toEqual([0, 0.5, 1]);
    expect(niceTicks(0)).toEqual([0, 1]);
  });

  test("a line per series, broken where a value is missing; a legend for two or more", async () => {
    const { container } = render(
      <main>
        <LineChart label="Calls per minute" series={two} formatTime={fmtTime} />
      </main>,
    );
    const paths = [...container.querySelectorAll("path")].map((p) => p.getAttribute("d") ?? "");
    expect(paths).toHaveLength(2);
    expect(paths[0]!.match(/M/g)).toHaveLength(2); // the gap starts a new stroke
    expect(paths[1]!.match(/M/g)).toHaveLength(1);
    const legend = screen.getByRole("list", { name: "Calls per minute: legend" });
    expect(
      within(legend)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["tasks:list", "Other functions"]);
    await expectAccessible();
  });

  test("one series needs no legend", () => {
    render(<LineChart label="Lag" series={[two[0]!]} />);
    expect(screen.queryByRole("list")).toBeNull();
  });

  test("the keyboard walks the buckets; each says every series' value", async () => {
    render(<LineChart label="Calls per minute" series={two} formatTime={fmtTime} formatValue={(v) => `${v} calls`} />);
    const user = userEvent.setup();
    await user.tab();
    const chart = screen.getByRole("figure", { name: "Calls per minute" });
    expect(document.activeElement).toBe(chart);
    await user.keyboard("{ArrowRight}");
    expect(chart.textContent).toContain("m0: tasks:list 1 calls, Other functions 3 calls");
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(chart.textContent).toContain("m2: tasks:list no data, Other functions 0 calls");
    await user.keyboard("{End}");
    expect(chart.textContent).toContain("m3: tasks:list 4 calls");
    await user.keyboard("{Escape}");
    expect(chart.textContent).not.toContain("m3:");
  });

  test("the numbers as a table, a row per bucket", async () => {
    render(<LineChart label="Calls" series={two} formatTime={fmtTime} />);
    await userEvent.setup().click(screen.getByText("Show as table"));
    const table = screen.getByRole("table", { name: "Calls" });
    const rows = within(table).getAllByRole("row");
    expect(rows.map((r) => r.textContent)).toEqual(["Timetasks:listOther functions", "m013", "m121", "m2—0", "m342"]);
  });

  test("nothing to draw says so", () => {
    render(<LineChart label="Calls" series={[{ ...two[0]!, points: pts(null, null) }]} empty="No function ran." />);
    expect(screen.getByText("No function ran.")).toBeDefined();
    expect(screen.queryByRole("figure")).toBeNull();
  });

  test("direct labels at the lines' ends", () => {
    const { container } = render(<LineChart label="Latency" series={two} directLabels />);
    const labels = [...container.querySelectorAll("svg text")].map((t) => t.textContent);
    expect(labels).toContain("tasks:list");
    expect(labels).toContain("Other functions");
  });
});
