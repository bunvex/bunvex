// Settings → Map style (UI-01 §26.2, STUDY-12 §16): a page the Analytics extension adds to Settings; the
// Realtime map's basemap is the bundled one unless a checked MapLibre style URL is chosen, per deployment.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { isMapLibreStyle, mapStyleProblem, readMapStyle } from "../src/extensions/analytics/map-style.ts";
import { expectAccessible } from "./axe.ts";

const realFetch = globalThis.fetch;
beforeEach(() => localStorage.clear());
afterEach(() => {
  globalThis.fetch = realFetch;
});
const respond = (body: unknown, status = 200) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
};
function mount(path: string, src = new MockDataSource({ seed: 3, executions: 5 })) {
  render(<Dashboard dataSource={src} history={createMemoryHistory({ initialEntries: [path] })} />);
}

describe("map style URLs", () => {
  test("https, or http on localhost; a style is version 8 with sources and layers", () => {
    expect(mapStyleProblem("https://tiles.example.com/style.json")).toBeUndefined();
    expect(mapStyleProblem("http://localhost:8080/style.json")).toBeUndefined();
    expect(mapStyleProblem("http://tiles.example.com/style.json")).toMatch(/https/);
    expect(mapStyleProblem("tiles.example.com")).toMatch(/Not a URL/);
    expect(isMapLibreStyle({ version: 8, sources: {}, layers: [] })).toBe(true);
    expect(isMapLibreStyle({ version: 7, sources: {}, layers: [] })).toBe(false);
    expect(isMapLibreStyle("nope")).toBe(false);
  });
});

describe("Settings → Map style", () => {
  test("listed under Extensions in Settings; a checked style is kept per deployment; the built-in one back", async () => {
    mount("/settings/general");
    const pages = await screen.findByRole("navigation", { name: "Settings" });
    const user = userEvent.setup();
    await user.click(within(pages).getByRole("link", { name: "Map style" }));
    await screen.findByRole("heading", { level: 1, name: "Map style" });
    expect(screen.getByRole("note").textContent).toMatch(/contacts it|third|provider/);
    const box = screen.getByRole("textbox", { name: "MapLibre style URL" });
    await user.type(box, "http://tiles.example.com/s.json");
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("button", { name: "Use this style" }).hasAttribute("disabled")).toBe(true);
    await user.clear(box);
    await user.type(box, "https://tiles.example.com/s.json");
    respond({ hello: "world" });
    await user.click(screen.getByRole("button", { name: "Use this style" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/not a MapLibre style/);
    expect(readMapStyle("default")).toBeNull();
    respond({ version: 8, sources: {}, layers: [] });
    await user.click(screen.getByRole("button", { name: "Use this style" }));
    await screen.findByText("The Realtime map now uses this style.");
    expect(readMapStyle("default")).toBe("https://tiles.example.com/s.json");
    await expectAccessible();
    await user.click(screen.getByRole("button", { name: "Use the built-in basemap" }));
    expect(readMapStyle("default")).toBeNull();
  });

  test("not listed when the deployment does not offer Analytics", async () => {
    const src = new MockDataSource({ seed: 3, executions: 5 });
    (src as unknown as Record<string, unknown>).getAnalyticsRealtime = undefined;
    mount("/settings/general", src);
    const pages = await screen.findByRole("navigation", { name: "Settings" });
    expect(within(pages).queryByRole("link", { name: "Map style" })).toBeNull();
  });
});
