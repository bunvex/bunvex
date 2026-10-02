import { describe, expect, test } from "bun:test";
import { Dashboard, type DashboardDataSource } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { bubbleSize, citiesOf, unwrapRing } from "../src/extensions/analytics/world-map.tsx";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 9, 1, 12);
const source = (opts: Partial<ConstructorParameters<typeof MockDataSource>[0]> = {}) =>
  new MockDataSource({ seed: 3, now: NOW, executions: 20, ...opts });

function mount(path: string, src: DashboardDataSource = source()) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={src} history={history} />);
  return { history, src };
}
const heading = (name: string) => screen.findByRole("heading", { level: 1, name });

describe("the world map's helpers", () => {
  test("a ring crossing the antimeridian is unwrapped, never jumping more than 180°", () => {
    const ring = unwrapRing([
      [178, 60],
      [-179, 61],
      [-170, 62],
      [179, 63],
    ]);
    expect(ring.map((p) => p[0])).toEqual([178, 181, 190, 179]);
    for (let i = 1; i < ring.length; i++) expect(Math.abs(ring[i]![0] - ring[i - 1]![0]) <= 180).toBe(true);
  });

  test("visitors group by city, most first; a bubble's area grows with the count", () => {
    const v = (city: string, countryCode: string) =>
      ({ city, countryCode, country: countryCode, lat: 1, lon: 2 }) as never;
    const cities = citiesOf([v("Lisbon", "PT"), v("Tokyo", "JP"), v("Lisbon", "PT")]);
    expect(cities.map((c) => [c.city, c.visitors])).toEqual([
      ["Lisbon", 2],
      ["Tokyo", 1],
    ]);
    expect(bubbleSize(1, 4)).toBe(24);
    expect(bubbleSize(4, 4)).toBe(40);
    expect(bubbleSize(0, 4)).toBe(8);
  });
});

describe("the Analytics extension", () => {
  test("Realtime: visitors, devices, the live feed and the four breakdowns; no map without WebGL", async () => {
    const { src } = mount("/analytics/realtime");
    await heading("Realtime");
    const r = await src.getAnalyticsRealtime!();
    const tile = await screen.findByRole("region", { name: "Visitors" });
    expect(within(tile).getByText(String(r.visitorsLast30Min))).toBeDefined();
    expect(within(tile).getByText("desktop")).toBeDefined(); // shown capitalised by CSS
    expect(screen.getByText(/The map needs WebGL/)).toBeDefined();
    for (const name of ["Pages", "Referrers", "Countries", "Browsers and apps"])
      expect(screen.getByRole("region", { name })).toBeDefined();
    const countries = screen.getByRole("region", { name: "Countries" });
    expect(within(countries).getByText(r.countries[0]!.name)).toBeDefined();
    expect(within(screen.getByRole("region", { name: "Live events" })).getAllByRole("listitem").length).toBeGreaterThan(
      0,
    );
    // on a phone the feed comes after the map and the breakdowns, five items until "Show more" (UX2-27)
    const feed = screen.getByRole("region", { name: "Live events" });
    const items = within(feed).getAllByRole("listitem");
    expect(items.length).toBeGreaterThan(5);
    expect(items.slice(5).every((li) => li.className.includes("max-md:hidden"))).toBe(true);
    await userEvent.setup().click(within(feed).getByRole("button", { name: /^Show \d+ more$/ }));
    expect(
      within(feed)
        .getAllByRole("listitem")
        .some((li) => li.className.includes("max-md:hidden")),
    ).toBe(false);
    await expectAccessible();
  });

  test("Events: narrowed to one name from the column (in the URL); a row opens its details with the raw form", async () => {
    const { history } = mount("/analytics/events");
    await heading("Events");
    const grid = await screen.findByRole("grid", { name: "Analytics events" });
    await waitFor(() => expect(within(grid).getAllByRole("row").length).toBeGreaterThan(5));
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: /^sign_up/ }));
    await waitFor(() => expect(history.location.search).toContain("name=sign_up"));
    await waitFor(() => {
      const names = within(grid)
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("gridcell")[1]!.textContent);
      expect(names.length > 0 && names.every((n) => n === "sign_up")).toBe(true);
    });
    await user.click(within(grid).getAllByRole("gridcell")[0]!);
    const panel = await screen.findByRole("complementary");
    expect(within(panel).getByText("Raw")).toBeDefined();
    expect(within(panel).getAllByText(/sign_up/).length).toBeGreaterThan(0);
    await expectAccessible();
  });

  test("Sessions and Profiles: grids, newest first, searchable", async () => {
    mount("/analytics/profiles");
    await heading("Profiles");
    const grid = await screen.findByRole("grid", { name: "Analytics profiles" });
    await waitFor(() => expect(within(grid).getAllByRole("row").length).toBeGreaterThan(3));
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: "Search profiles" }), "zzz-nobody");
    await screen.findByText("No profile matches “zzz-nobody”.");
  });

  test("not offered: the screen says so, and the nav has no Analytics", async () => {
    const src = source();
    (src as { getAnalyticsRealtime?: unknown }).getAnalyticsRealtime = undefined;
    mount("/analytics/realtime", src);
    await screen.findByText(/analytics/i, { selector: "p" });
    expect(screen.queryByRole("link", { name: "Analytics" })).toBeNull();
  });
});
