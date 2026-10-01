import { describe, expect, test } from "bun:test";
import { Dashboard, type DashboardDataSource, type Topology } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { eventText, lagText, summary, uptime } from "../src/topology/words.ts";
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
/** The screen with its picture loaded. */
const loaded = async () => {
  await heading();
  await screen.findByTestId("topology-summary");
};
const lane = (name: string) => screen.getByRole("region", { name });

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
  test("summary, lag, uptime and events", async () => {
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
  });
});

describe("the Topology screen", () => {
  test("one node (bunvex today): the node and its store, and where followers will appear", async () => {
    mount("/topology");
    await loaded();
    expect(screen.getByTestId("topology-summary").textContent).toMatch(/^Leader node-a · no followers/);
    expect(screen.queryByRole("region", { name: "Followers" })).toBeNull();
    const node = lane("Node");
    expect(within(node).getByText("node-a")).toBeDefined();
    expect(within(node).getByText("Followers appear here when bunvex runs more than one node.")).toBeDefined();
    expect(within(node).getByText("Runs the scheduler")).toBeDefined();
    expect(within(lane("Store")).getByText("One node: a file lock keeps a second one out.")).toBeDefined();
    expect(within(lane("Clients")).getByText(/connections to/).textContent).toContain("node-a");
    await expectAccessible();
  });

  test("several nodes: clients go to the followers, followers show their lag, the leader holds the lease", async () => {
    mount("/topology", source({ nodes: 4 }));
    await loaded();
    expect(screen.getByTestId("topology-summary").textContent).toContain("3 followers");
    const followers = within(lane("Followers")).getAllByRole("listitem");
    expect(followers.map((li) => within(li).getByRole("button").textContent)).toEqual([
      expect.stringContaining("node-b"),
      expect.stringContaining("node-c"),
      expect.stringContaining("node-d"),
    ]);
    for (const li of followers) expect(li.textContent).toMatch(/commits? · [\d,]+ ms behind/);
    expect(
      within(lane("Clients"))
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringContaining("node-b"),
      expect.stringContaining("node-c"),
      expect.stringContaining("node-d"),
    ]);
    expect(within(lane("Leader")).getByText(/streams to 3 followers/)).toBeDefined();
    expect(within(lane("Store")).getByText(/Lease held by/).textContent).toMatch(
      /node-a, renews within \d+ s \(TTL 10 s\)/,
    );
    await expectAccessible();
  });

  test("a lagging follower says so in words, not colour alone", async () => {
    const src = await withTopology((t) => {
      const d = t.nodes.find((n) => n.id === "node-d")!;
      d.state = "lagging";
      d.lag = { commits: 101, ms: 840 };
    });
    mount("/topology", src);
    await loaded();
    const card = within(lane("Followers")).getAllByRole("button")[2]!;
    expect(card.textContent).toContain("Lagging");
    expect(card.textContent).toContain("101 commits · 840 ms behind");
    expect(screen.getByTestId("topology-summary").textContent).toContain("max lag 840 ms");
  });

  test("the events feed, newest first", async () => {
    const src = await withTopology((t) => {
      t.events = [
        { id: "e2", time: NOW, kind: "node_caught_up", node: "node-d" },
        { id: "e1", time: NOW - 60_000, kind: "node_lagging", node: "node-d", detail: "840 ms behind" },
      ];
    });
    mount("/topology", src);
    await loaded();
    const events = within(screen.getByRole("region", { name: "Events" })).getAllByRole("listitem");
    expect(events.map((li) => li.textContent?.replace(/^.*?\d{1,2}:\d{2}:\d{2}\s?(AM|PM)?/, ""))).toEqual([
      "node-d caught up",
      "node-d fell behind (840 ms behind)",
    ]);
  });

  test("a node opens its details beside the lanes, in the URL; Escape closes them", async () => {
    const { history } = mount("/topology", source({ nodes: 4 }));
    await loaded();
    const user = userEvent.setup();
    await user.click(within(lane("Followers")).getAllByRole("button")[0]!);
    const panel = await screen.findByRole("complementary", { name: "node-b" });
    expect(history.location.search).toBe("?node=node-b");
    expect(within(panel).getByText("Follower")).toBeDefined();
    expect(within(panel).getByText("On the leader")).toBeDefined();
    expect(within(panel).getByText(/^CPU, last \d+ s$/)).toBeDefined();
    expect(within(panel).getByText(/^Lag, last \d+ s$/)).toBeDefined();
    await expectAccessible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    expect(history.location.search).toBe("");
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
