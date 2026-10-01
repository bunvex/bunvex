// The topology said in words (UI-01 §22): the one-line summary, a node's lag, uptime, the store, and each
// event. The screen and its tests share them, so what is drawn is also what is read.
import type { NodeState, StoreDriver, Topology, TopologyEvent, TopologyNode } from "../data-source.ts";
import { formatCount } from "../screens/stats.ts";

export const DRIVER: Record<StoreDriver, string> = {
  memory: "Memory",
  sqlite: "SQLite",
  postgres: "Postgres",
  mysql: "MySQL",
  mongodb: "MongoDB",
};

export const STATE: Record<NodeState, string> = { ok: "OK", lagging: "Lagging", down: "Down" };

const plural = (n: number, one: string, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`;

/** "3 commits · 840 ms behind". */
export const lagText = (lag: NonNullable<TopologyNode["lag"]>) =>
  `${plural(lag.commits, "commit")} · ${formatCount(lag.ms)} ms behind`;

/** "26 h 4 min", "3 min", "45 s". */
export function uptime(startedAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** The node that serves clients: the followers, or a leader alone. */
export const servesClients = (n: TopologyNode, t: Topology) => n.role === "follower" || t.nodes.length === 1;

export function summary(t: Topology): string {
  const leader = t.nodes.find((n) => n.role === "leader");
  const followers = t.nodes.filter((n) => n.role === "follower");
  const clients = t.nodes.filter((n) => servesClients(n, t)).reduce((sum, n) => sum + n.connections, 0);
  const lags = followers.flatMap((n) => (n.lag ? [n.lag.ms] : []));
  const store = t.store;
  const storeOk = store.singleNode || store.leaseHolder !== null;
  return [
    leader ? `Leader ${leader.id}` : "No leader",
    followers.length === 0 ? "no followers" : plural(followers.length, "follower"),
    plural(clients, "client"),
    ...(lags.length ? [`max lag ${formatCount(Math.max(...lags))} ms`] : []),
    `${DRIVER[store.driver]} ${storeOk ? "OK" : "without a lease holder"}`,
  ].join(" · ");
}

export function eventText(e: TopologyEvent): string {
  const node = e.node ?? "A node";
  switch (e.kind) {
    case "node_joined":
      return `${node} joined`;
    case "node_left":
      return `${node} left`;
    case "leader_changed":
      return `${node} became the leader${e.detail ? ` (was ${e.detail})` : ""}`;
    case "lease_acquired":
      return `${node} took the lease on the store`;
    case "lease_expired":
      return `${node}'s lease expired`;
    case "node_lagging":
      return `${node} fell behind${e.detail ? ` (${e.detail})` : ""}`;
    case "node_caught_up":
      return `${node} caught up`;
  }
}
