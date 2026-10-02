import { describe, expect, test } from "bun:test";
import { Dashboard, type DashboardDataSource, type Topology } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { streamLook, toFlow } from "../src/topology/diagram.tsx";
import { layoutTopology, neighbourhood } from "../src/topology/layout.ts";
import { compact, eventText, lagText, summary, uptime } from "../src/topology/words.ts";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 9, 1, 12);
const source = (opts: Partial<ConstructorParameters<typeof MockDataSource>[0]> = {}) =>
  new MockDataSource({ seed: 3, now: NOW, executions: 20, topologyIntervalMs: 60_000, ...opts });

function mount(path: string, src: DashboardDataSource = source()) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={src} history={history} />);
  return { history, src };
}
const heading = () => screen.findByRole("heading", { level: 1, name: "Topology" });
/** The screen with its picture loaded and the diagram's cards drawn. */
const loaded = async (cards: number) => {
  await heading();
  await screen.findByTestId("topology-summary");
  await waitFor(() => expect(document.querySelectorAll(".react-flow__node").length).toBe(cards));
};
const card = (id: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;

/** A source whose topology is this picture, with no live updates (so a test controls the state). */
async function withTopology(edit: (t: Topology) => void, opts = {}) {
  const src = source({ nodes: 4, ...opts });
  const t = await src.getTopology();
  edit(t);
  src.getTopology = async () => structuredClone(t);
  src.watchTopology = () => () => {};
  return src;
}

describe("the topology in words", () => {
  test("summary, lag, uptime, events and compact counts", async () => {
    const t = await source({ nodes: 4 }).getTopology();
    expect(summary(t)).toMatch(/^Leader node-a · 3 followers · [\d,]+ clients · max lag [\d,]+ ms · Postgres OK$/);
    const one = await source().getTopology();
    expect(summary(one)).toMatch(/^Leader node-a · no followers · [\d,]+ clients · Memory OK$/);
    expect(lagText({ commits: 1, ms: 840 })).toBe("1 commit · 840 ms behind");
    expect(uptime(0, 45_000)).toBe("45 s");
    expect(uptime(0, 26 * 3_600_000 + 4 * 60_000)).toBe("26 h 4 min");
    expect(eventText({ id: "1", time: 0, kind: "node_lagging", node: "node-d", detail: "840 ms behind" })).toBe(
      "node-d fell behind (840 ms behind)",
    );
    expect(eventText({ id: "2", time: 0, kind: "leader_changed", node: "node-b", detail: "node-a" })).toBe(
      "node-b became the leader (was node-a)",
    );
    expect([compact(640), compact(3_100), compact(5_000)]).toEqual(["640", "3.1k", "5k"]);
  });
});

describe("the layout", () => {
  test("wide: fixed layers; positions depend on the nodes, never on their numbers", async () => {
    const src = source({ nodes: 4 });
    const before = layoutTopology(await src.getTopology());
    const changed = await src.getTopology();
    for (const n of changed.nodes) {
      n.connections += 500;
      if (n.lag) n.lag = { commits: 999, ms: 2000 };
      if (n.cache) n.cache.entries = 1;
    }
    expect(layoutTopology(changed)).toEqual(before);
    const at = (id: string) => before.placed.find((p) => p.id === id)!;
    expect(at("clients:node-b").y).toBeLessThan(at("node:node-b").y);
    expect(at("node:node-b").y).toBeLessThan(at("node:node-a").y);
    expect(at("node:node-a").y).toBeLessThan(at("store").y);
    // followers side by side, well apart; the leader and the store centred under them
    expect(at("node:node-c").x - at("node:node-b").x).toBeGreaterThanOrEqual(300);
    expect(at("node:node-a").x).toBe(at("node:node-c").x);
    expect(before.links.map((l) => l.id)).toEqual([
      "ws:node-b",
      "ws:node-c",
      "ws:node-d",
      "stream:node-b",
      "stream:node-c",
      "stream:node-d",
      "commits",
    ]);
    const one = layoutTopology(await source().getTopology());
    expect(one.placed.map((p) => p.id)).toEqual(["clients:node-a", "node:node-a", "store"]);
    expect(neighbourhood("node-b", before.links)).toEqual(
      new Set(["node:node-b", "clients:node-b", "ws:node-b", "stream:node-b", "node:node-a"]),
    );
  });

  test("narrow (a phone): one column, each follower under its clients, then the leader and the store", async () => {
    const { placed, width } = layoutTopology(await source({ nodes: 4 }).getTopology(), "narrow");
    expect(placed.map((p) => p.id)).toEqual([
      "clients:node-b",
      "node:node-b",
      "clients:node-c",
      "node:node-c",
      "clients:node-d",
      "node:node-d",
      "node:node-a",
      "store",
    ]);
    expect(new Set(placed.map((p) => p.x)).size).toBe(1);
    expect(placed.every((p, i) => i === 0 || p.y > placed[i - 1]!.y)).toBe(true);
    expect(width).toBeLessThan(320);
  });
});

describe("the mock's caches", () => {
  test("each node's LRU stays within its capacity, evicting past it; invalidations follow the commits", async () => {
    const { MockTopology } = await import("../src/mock/topology.ts");
    const { createRandom } = await import("../src/mock/random.ts");
    const topo = new MockTopology(createRandom(1), { nodes: 4, now: NOW, version: "x", persistence: "postgres" });
    const before = topo.snapshot().nodes.map((n) => n.cache!.evictions);
    for (let i = 0; i < 400; i++) topo.step(1000);
    const t = topo.snapshot();
    for (const [i, n] of t.nodes.entries()) {
      const c = n.cache!;
      expect(c.entries).toBeLessThanOrEqual(c.maxEntries);
      expect(c.bytes!).toBeLessThanOrEqual(c.maxBytes!);
      if (n.role === "follower") expect(c.evictions).toBeGreaterThan(before[i]!);
      const cps = t.nodes[0]!.commitsPerSecond!;
      expect(c.invalidationsPerSecond).toBeGreaterThan(cps * 0.25);
      expect(c.invalidationsPerSecond).toBeLessThan(cps * 0.5);
    }
  });
});

describe("the diagram's edges and nodes", () => {
  test("the commit stream: width by commits/s, colour and particles by the follower's state", () => {
    const follower = (state: "ok" | "lagging" | "down") => ({ state }) as never;
    expect(streamLook(40, follower("ok")).width).toBeLessThan(streamLook(240, follower("ok")).width);
    expect(streamLook(120, follower("ok")).tone).toBe("normal");
    expect(streamLook(120, follower("lagging")).tone).toBe("warning");
    expect(streamLook(120, follower("down"))).toMatchObject({ tone: "critical", particles: 0 });
    expect(streamLook(240, follower("ok")).particles).toBeGreaterThan(streamLook(40, follower("ok")).particles);
  });

  test("the edges say what flows; a node's label says its state, lag, clients and cache", async () => {
    const t = await (
      await withTopology((t) => {
        const d = t.nodes.find((n) => n.id === "node-d")!;
        d.state = "lagging";
        d.lag = { commits: 101, ms: 840 };
        d.cache = { ...d.cache!, hitRate: 0.9, entries: 3100, maxEntries: 5000 };
        t.nodes.find((n) => n.id === "node-b")!.lag = { commits: 1, ms: 15 };
      })
    ).getTopology();
    const { edges, nodes } = toFlow(t, undefined);
    const label = (id: string) => edges.find((e) => e.id === id)!.data!.label;
    expect(label("stream:node-d")).toBe("101 commits · 840 ms · lagging");
    expect(label("stream:node-b")).toBe("1 commit · 15 ms");
    expect(edges.find((e) => e.id === "stream:node-d")!.data!.tone).toBe("warning");
    expect(label("ws:node-b")).toMatch(/^[\d,]+ ws$/);
    expect(label("commits")).toMatch(/^[\d,]+ commits\/s$/);
    expect(edges.find((e) => e.id === "commits")!.data!.lock).toBe(true);
    expect(nodes.find((n) => n.id === "node:node-d")!.ariaLabel).toContain(
      "node-d, follower, lagging, 101 commits · 840 ms behind",
    );
    expect(nodes.find((n) => n.id === "node:node-d")!.ariaLabel).toContain("cache 90% hits, 3,100 of 5,000 entries");
    // on a phone the streams run along the left margin
    const narrow = toFlow(t, undefined, "narrow").edges.find((e) => e.id === "stream:node-d")!;
    expect([narrow.sourceHandle, narrow.targetHandle]).toEqual(["out-left", "in-left"]);
  });
});

describe("the Topology screen", () => {
  test("one node (bunvex today): clients, the node and its store; where followers will appear", async () => {
    mount("/topology");
    await loaded(3);
    expect(screen.getByTestId("topology-summary").textContent).toMatch(/^Leader node-a · no followers/);
    expect(screen.getByText(/followers appear when bunvex runs more than one/)).toBeDefined();
    expect(card("node:node-a").getAttribute("aria-label")).toMatch(/^node-a, the only node, OK/);
    expect(card("store").textContent).toContain("One node: a file lock keeps a second one out");
    expect(screen.queryByRole("button", { name: "List" })).toBeNull();
    await expectAccessible();
  });

  test("each server card ends in its own cache strip: hit rate, occupancy, invalidations per second", async () => {
    const src = await withTopology((t) => {
      const b = t.nodes.find((n) => n.id === "node-b")!;
      b.cache = { ...b.cache!, hitRate: 0.9, entries: 3100, maxEntries: 5000, invalidationsPerSecond: 42 };
    });
    mount("/topology", src);
    await loaded(8);
    const strips = document.querySelectorAll("[data-cache-strip]");
    expect(strips.length).toBe(4);
    const strip = card("node:node-b").querySelector("[data-cache-strip]")!;
    expect(strip.textContent).toBe("Cache90%3.1k/5k42/s");
  });

  test("a focused node opens with Enter; its Cache tab shows the node's own cache", async () => {
    const src = await withTopology((t) => {
      const b = t.nodes.find((n) => n.id === "node-b")!;
      b.cache = {
        ...b.cache!,
        entries: 3100,
        maxEntries: 5000,
        evictions: 950,
        topQueries: [
          { function: "tasks:list", entries: 1200 },
          { function: "messages:list", entries: 900 },
        ],
      };
    });
    const { history } = mount("/topology", src);
    await loaded(8);
    card("node:node-b").focus();
    const user = userEvent.setup();
    await user.keyboard("{Enter}");
    const panel = await screen.findByRole("complementary", { name: "node-b" });
    expect(new URLSearchParams(history.location.search).get("node")).toBe("node-b");
    expect(within(panel).getByText("On the leader")).toBeDefined();
    await user.click(within(panel).getByRole("tab", { name: "Cache" }));
    const cache = await within(panel).findByTestId("cache-details");
    expect(within(cache).getByText("3,100 of 5,000")).toBeDefined();
    expect(within(cache).getByText("950")).toBeDefined();
    expect(within(cache).getByText("Hit rate, last minute")).toBeDefined();
    expect(within(cache).getByText("Invalidations per second, last minute")).toBeDefined();
    const top = within(cache)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(top).toEqual(["tasks:list1,200", "messages:list900"]);
    await expectAccessible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
  });

  test("the events, docked under the diagram: the newest in a line; opened, one lights its node", async () => {
    const src = await withTopology((t) => {
      t.events = [
        { id: "e2", time: NOW, kind: "node_caught_up", node: "node-d" },
        { id: "e1", time: NOW - 60_000, kind: "node_lagging", node: "node-d", detail: "840 ms behind" },
      ];
    });
    mount("/topology", src);
    await loaded(8);
    const region = screen.getByRole("region", { name: /^Events/ });
    const toggle = within(region).getByRole("button", { expanded: false });
    expect(within(region).queryAllByRole("listitem").length).toBe(0); // collapsed: the canvas keeps its height
    expect(toggle.textContent).toContain("node-d caught up");
    const user = userEvent.setup();
    await user.click(toggle);
    const events = within(region).getAllByRole("listitem");
    expect(events.map((li) => li.textContent?.replace(/^.*?\d{1,2}:\d{2}:\d{2}\s?(AM|PM)?/, ""))).toEqual([
      "node-d caught up",
      "node-d fell behind (840 ms behind)",
    ]);
    await user.click(within(events[0]!).getByRole("button"));
    const dim = (id: string) => card(id).querySelector(":scope > div")!.className.includes("opacity-30");
    await waitFor(() => expect(dim("node:node-b")).toBe(true));
    expect(dim("node:node-d")).toBe(false);
    expect(dim("node:node-a")).toBe(false);
  });

  test("a credential that cannot view metrics is told so", async () => {
    mount("/topology", source({ capabilities: { operations: ["viewData"], readOnly: true } }));
    await heading();
    await screen.findByText("This credential cannot view the deployment's topology.");
  });

  test("a source without a topology says it does not offer one", async () => {
    const src = source();
    // biome-ignore lint/suspicious/noExplicitAny: removing an optional method
    (src as any).getTopology = undefined;
    mount("/topology", src);
    await heading();
    expect(screen.getByText("This deployment does not offer its topology yet.")).toBeDefined();
  });
});
