// Where the Topology diagram draws everything (UI-01 §22): fixed layers, top to bottom — the clients of each
// serving node, the followers, the leader, the store — so a node's place depends only on which nodes exist,
// never on their numbers: live updates never move anything. With one node: clients → node → store, centred.
import type { Topology, TopologyNode } from "../data-source.ts";
import { servesClients } from "./words.ts";

export const NODE_W = 248;
export const GAP_X = 40;
/** The top of each layer. */
export const ROW = { clients: 0, followers: 120, leader: 370, store: 560 } as const;
const ROW_SINGLE = { clients: 0, leader: 120, store: 330 } as const;

export type Placed =
  | { kind: "clients"; id: string; x: number; y: number; node: string }
  | { kind: "server"; id: string; x: number; y: number; node: string }
  | { kind: "store"; id: string; x: number; y: number };

export type Link =
  /** Clients' WebSockets to the node that serves them. */
  | { kind: "clients"; id: string; source: string; target: string; node: string }
  /** The commit stream from the leader to a follower. */
  | { kind: "stream"; id: string; source: string; target: string; node: string }
  /** The leader's commits to the store (it holds the lease). */
  | { kind: "store"; id: string; source: string; target: string; node: string };

export const clientsId = (node: string) => `clients:${node}`;
export const serverId = (node: string) => `node:${node}`;
export const STORE_ID = "store";

/** Places and links for `t`'s nodes; equal for any two pictures with the same node ids and roles. */
export function layoutTopology(t: Topology): { placed: Placed[]; links: Link[] } {
  const leader = t.nodes.find((n) => n.role === "leader");
  const followers = t.nodes.filter((n) => n.role === "follower");
  const serving: TopologyNode[] = t.nodes.filter((n) => servesClients(n, t));
  const single = followers.length === 0;
  const width = Math.max(1, serving.length) * (NODE_W + GAP_X) - GAP_X;
  const centre = (w: number) => (width - w) / 2;
  const column = (i: number) => i * (NODE_W + GAP_X);
  const row = single ? ROW_SINGLE : ROW;
  const placed: Placed[] = [];
  const links: Link[] = [];
  serving.forEach((n, i) => {
    placed.push({ kind: "clients", id: clientsId(n.id), x: column(i), y: row.clients, node: n.id });
    links.push({ kind: "clients", id: `ws:${n.id}`, source: clientsId(n.id), target: serverId(n.id), node: n.id });
  });
  followers.forEach((n, i) => {
    placed.push({ kind: "server", id: serverId(n.id), x: column(i), y: ROW.followers, node: n.id });
  });
  if (leader) {
    placed.push({ kind: "server", id: serverId(leader.id), x: centre(NODE_W), y: row.leader, node: leader.id });
    for (const f of followers)
      links.push({
        kind: "stream",
        id: `stream:${f.id}`,
        source: serverId(leader.id),
        target: serverId(f.id),
        node: f.id,
      });
    links.push({ kind: "store", id: "commits", source: serverId(leader.id), target: STORE_ID, node: leader.id });
  }
  placed.push({ kind: "store", id: STORE_ID, x: centre(NODE_W), y: row.store });
  return { placed, links };
}

/** The ids of what a node touches: itself, its clients, and the links to and from it. */
export function neighbourhood(node: string, links: Link[]): Set<string> {
  const ids = new Set<string>([serverId(node), clientsId(node)]);
  for (const l of links)
    if (l.source === serverId(node) || l.target === serverId(node)) {
      ids.add(l.id);
      ids.add(l.source);
      ids.add(l.target);
    }
  return ids;
}
