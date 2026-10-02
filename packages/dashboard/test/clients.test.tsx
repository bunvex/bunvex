import { describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { compareVersions, sdkState, type Topology } from "@bunvex/dashboard/data-source";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { groupClients } from "../src/clients/words.tsx";
import { layoutTopology } from "../src/topology/layout.ts";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const source = (opts: Partial<ConstructorParameters<typeof MockDataSource>[0]> = {}) =>
  new MockDataSource({ seed: 3, now: NOW, executions: 20, topologyIntervalMs: 60_000, ...opts });

/** A source frozen on its first picture (no live updates). */
async function frozen(opts = {}) {
  const src = source({ nodes: 4, ...opts });
  const t = await src.getTopology();
  src.getTopology = async () => structuredClone(t);
  src.watchTopology = () => () => {};
  return { src, t };
}

describe("who the clients are", () => {
  test("versions compare by number; an SDK's state follows the policy", () => {
    expect(compareVersions("2.10.0", "2.9.3")).toBe(1);
    expect(compareVersions("0.4", "0.4.0")).toBe(0);
    expect(compareVersions("0.3.8-beta.1", "0.4.0")).toBe(-1);
    const policy = { node: { upgradeBelow: "0.4.0", unsupportedBelow: "0.3.0" } };
    expect(sdkState("node", "0.4.2", policy)).toBe("supported");
    expect(sdkState("node", "0.3.8", policy)).toBe("upgrade");
    expect(sdkState("node", "0.2.9", policy)).toBe("unsupported");
    expect(sdkState("web", "0.0.1", policy)).toBe("supported");
  });

  test("grouped by platform or by app, in a fixed order; each group adds up across nodes", async () => {
    const { src, t } = await frozen();
    const apps = await src.listClientApps();
    const byPlatform = groupClients(t.nodes, "platform", apps);
    expect(byPlatform.map((g) => g.label)).toEqual(["Web", "iOS", "Android", "Expo", "Node", "Bun"]);
    const total = t.nodes.reduce((a, n) => a + n.connections, 0);
    expect(byPlatform.reduce((a, g) => a + g.connections, 0)).toBe(total);
    for (const g of byPlatform) expect(g.perNode.reduce((a, p) => a + p.connections, 0)).toBe(g.connections);
    const byApp = groupClients(t.nodes, "app", apps).map((g) => g.label);
    expect(byApp).toEqual([
      "Shop Web",
      "Shop iOS",
      "Shop Android",
      "Unregistered · Expo",
      "Unregistered · Node",
      "Unregistered · Bun",
    ]);
    // more connections never reorder the cards
    const busier = structuredClone(t);
    for (const n of busier.nodes)
      for (const b of n.clients ?? []) b.connections *= 1 + Number(b.platform === "bun") * 50;
    expect(groupClients(busier.nodes, "platform", apps).map((g) => g.key)).toEqual(byPlatform.map((g) => g.key));
  });

  test("the layout: the groups' row above the followers, one link per group and serving node", async () => {
    const { t } = await frozen();
    const groups = groupClients(t.nodes, "platform", []);
    const { placed, links } = layoutTopology(t, "wide", groups);
    const at = (id: string) => placed.find((p) => p.id === id)!;
    expect(placed.filter((p) => p.kind === "group").length).toBe(groups.length);
    expect(placed.some((p) => p.kind === "clients")).toBe(false);
    expect(at("group:platform:web").y).toBeLessThan(at("node:node-b").y);
    const ws = links.filter((l) => l.kind === "clients");
    expect(ws.length).toBe(groups.reduce((a, g) => a + g.perNode.filter((p) => p.connections > 0).length, 0));
    expect(ws.every((l) => l.source.startsWith("group:") && l.target.startsWith("node:"))).toBe(true);
    // a phone: the groups head the column, and no group link is drawn across it
    const narrow = layoutTopology(t, "narrow", groups).placed.map((p) => p.id);
    expect(narrow.slice(0, groups.length).every((id) => id.startsWith("group:"))).toBe(true);
  });

  test("a registered app re-labels its clients at once", async () => {
    const src = source({ nodes: 1 });
    await src.createClientApp({ name: "Staff", platform: "expo", identifiers: ["com.acme.staff"] });
    const t = await src.getTopology();
    const apps = await src.listClientApps();
    expect(groupClients(t.nodes, "app", apps).map((g) => g.label)).toContain("Staff");
    expect(apps.find((a) => a.name === "Staff")!.versionsSeen.map((v) => v.version)).toEqual(["1.4.0"]);
  });
});

describe("clients on the Topology screen", () => {
  test("one card per platform, linked to its nodes; by app on request; a group's versions in its panel", async () => {
    const { src } = await frozen();
    const history = createMemoryHistory({ initialEntries: ["/topology"] });
    render(<Dashboard dataSource={src} history={history} />);
    await screen.findByRole("heading", { level: 1, name: "Topology" });
    const card = (key: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="group:${key}"]`);
    await waitFor(() => expect(card("platform:web")).not.toBeNull());
    expect(card("platform:web")!.getAttribute("aria-label")).toMatch(/^Web: [\d,]+ clients, on node-b /);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "App" }));
    await waitFor(() => expect(new URLSearchParams(history.location.search).get("clientsBy")).toBe("app"));
    await waitFor(() => expect(card("unregistered:node")).not.toBeNull());
    expect(screen.getByRole("button", { name: "App" }).getAttribute("aria-pressed")).toBe("true");
    card("unregistered:node")!.focus();
    await user.keyboard("{Enter}");
    const panel = await screen.findByRole("complementary", { name: "Unregistered · Node" });
    expect(new URLSearchParams(history.location.search).get("clients")).toBe("unregistered:node");
    const sdk = within(panel).getByRole("region", { name: "SDK versions" });
    await waitFor(() => expect(sdk.textContent).toContain("Upgrade required"));
    expect(sdk.textContent).toContain("Node SDK 0.3.8");
    await expectAccessible();
  });

  test("a source that cannot tell who its clients are keeps one clients card per node", async () => {
    const src = source({ nodes: 4 });
    const t: Topology = await src.getTopology();
    for (const n of t.nodes) delete n.clients;
    src.getTopology = async () => structuredClone(t);
    src.watchTopology = () => () => {};
    render(<Dashboard dataSource={src} history={createMemoryHistory({ initialEntries: ["/topology"] })} />);
    await screen.findByRole("heading", { level: 1, name: "Topology" });
    await waitFor(() => expect(document.querySelector('.react-flow__node[data-id="clients:node-b"]')).not.toBeNull());
    expect(screen.queryByRole("group", { name: "Group clients by" })).toBeNull();
  });
});

describe("clients on the Overview", () => {
  test("outdated SDKs need attention: unsupported is critical, an upgrade a warning, each pointing at its platform", async () => {
    const summary = await source({ nodes: 4 }).getClientSummary();
    const { attention } = await import("../src/screens/overview-data.ts");
    const items = attention({ clients: summary }).filter((a) => a.id.startsWith("sdk-"));
    expect(items.map((a) => [a.severity, a.search?.clients])).toEqual([
      ["critical", "platform:android"],
      // warnings by how many connections they concern, most first
      ["warning", "platform:node"],
      ["warning", "platform:ios"],
    ]);
    expect(items[0]!.text).toMatch(/^\d+ Android clients? runs? SDK 0\.1\.5: no longer supported$/);
  });

  test("the Clients block: connections by platform and the SDK versions in use; the attention item opens the group", async () => {
    render(<Dashboard dataSource={source({ nodes: 4 })} history={createMemoryHistory({ initialEntries: ["/"] })} />);
    const block = await screen.findByTestId("overview-clients");
    const platforms = within(block).getByRole("list", { name: "Connections by platform" });
    expect(
      within(platforms)
        .getAllByRole("listitem")
        .map((li) => li.textContent?.replace(/[\d,%.]+/g, "")),
    ).toEqual(["Web", "iOS", "Android", "Expo", "Node", "Bun"]);
    const sdk = within(block).getByRole("list", { name: "SDK versions in use" });
    expect(sdk.textContent).toContain("Unsupported");
    const link = await screen.findByRole("link", { name: /Android clients? runs? SDK 0\.1\.5/ });
    expect(link.getAttribute("href")).toBe("/topology?clients=platform%3Aandroid");
    await expectAccessible();
  });
});
