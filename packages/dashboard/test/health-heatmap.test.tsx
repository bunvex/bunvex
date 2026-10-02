// The Health rate cards' heatmap view (UI-01 §18.4), as Convex's: failure rate opens as a line chart, cache hit
// rate as a heatmap; the switch is kept in this browser; rows worst first.
import { beforeEach, describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { heatmapRows } from "../src/metrics/health.tsx";
import { expectAccessible } from "./axe.ts";

const mount = () =>
  render(
    <Dashboard
      // the real clock: the metrics window is the last hour of it
      dataSource={new MockDataSource({ seed: 3, executions: 400 })}
      history={createMemoryHistory({ initialEntries: ["/"] })}
    />,
  );

beforeEach(() => localStorage.clear());

describe("heatmap rows", () => {
  test("worst first: failures high first, cache hits low first; rows without values last", () => {
    const s = (vs: (number | null)[]) => vs.map((value, i) => ({ time: i, value }));
    const top = [
      { function: "a", series: s([10, 10]) },
      { function: "b", series: s([90, null]) },
      { function: "c", series: s([null, null]) },
    ];
    expect(heatmapRows(top, "failurePercentage").map((r) => r.id)).toEqual(["b", "a", "c"]);
    expect(heatmapRows(top, "cacheHitPercentage").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("the Health rate cards", () => {
  test("cache hit rate opens as a heatmap, failure rate as a chart; the switch is kept", async () => {
    mount();
    const section = await screen.findByRole("region", { name: "Functions, last hour" });
    const cache = within(section).getByRole("region", { name: "Cache hit rate" });
    await waitFor(() => expect(cache.querySelector('[data-slot="heatmap"]') !== null).toBe(true));
    const failure = within(section).getByRole("region", { name: "Failure rate" });
    // plain selectors in this card: role queries over a page of charts are slow in happy-dom
    // the line chart has a table view of its own: look for the heatmap itself
    expect(failure.querySelector('[data-slot="heatmap"]') === null).toBe(true);
    const toHeatmap = [...failure.querySelectorAll("button")].find((b) => b.textContent === "Heatmap")!;
    expect(toHeatmap.getAttribute("aria-pressed")).toBe("false");
    await userEvent.setup().click(toHeatmap);
    await waitFor(() =>
      expect(
        within(section).getByRole("region", { name: "Failure rate" }).querySelector('[data-slot="heatmap"]') !== null,
      ).toBe(true),
    );
    expect(localStorage.getItem("bunvex:health-failurePercentage-view")).toBe("heatmap");
    // the cards alone: role queries and axe over every card's cells would take long
    await expectAccessible(cache);
  }, 30_000);
});
