// Where the Topology diagram draws everything (UI-01 §22). A node's place depends only on which nodes exist,
// never on their numbers: live updates never move anything.
// - Wide: fixed layers, top to bottom — the clients of each serving node, the followers side by side, the
//   leader, the store — centred. One node: clients → node → store.
// - Narrow (a phone): one column, read top to bottom at a readable zoom — each follower under its clients, then
//   the leader, then the store; the commit streams climb along the left margin, one lane per follower, so
//   they never cross a card.
import type { Topology, TopologyNode } from "../data-source.ts";
import { servesClients } from "./words.ts";

export const NODE_W = 220;
/** Between followers side by side. */
export const GAP_X = 120;
/** The top of each layer (wide). Cards are about 100 px high: the gaps leave room for the edges' labels. */
export const ROW = { clients: 0, followers: 190, leader: 520, store: 760 } as const;
const ROW_SINGLE = { clients: 0, leader: 190, store: 440 } as const;
/** Narrow: the gap under a card, and room on the left for the stream lanes. */
const NARROW_GAP = 64;
export const NARROW_LANES = 72;
const H = { clients: 52, server: 112, store: 84 } as const;

export type LayoutMode = "wide" | "narrow";

export type Placed =
  | { kind: "clients"; id: string; x: number; y: number; node: string }
  | { kind: "server"; id: string; x: number; y: number; node: string }
  | { kind: "store"; id: string; x: number; y: number };

export type Link =
  /** Clients' WebSockets to the node that serves them. */
  | { kind: "clients"; id: string; source: string; target: string; node: string }
  /** The commit stream from the leader to a follower; `lane` orders the narrow layout's margin lanes. */
  | { kind: "stream"; id: string; source: string; target: string; node: string; lane: number }
  /** The leader's commits to the store (it holds the lease). */
  | { kind: "store"; id: string; source: string; target: string; node: string };

export const clientsId = (node: string) => `clients:${node}`;
export const serverId = (node: string) => `node:${node}`;
export const STORE_ID = "store";

/** Places and links for `t`'s nodes; equal for any two pictures with the same node ids and roles. */
export function layoutTopology(
  t: Topology,
  mode: LayoutMode = "wide",
): { placed: Placed[]; links: Link[]; width: number } {
  const leader = t.nodes.find((n) => n.role === "leader");
  const followers = t.nodes.filter((n) => n.role === "follower");
  const serving: TopologyNode[] = t.nodes.filter((n) => servesClients(n, t));
  const links: Link[] = serving.map((n) => ({
    kind: "clients",
    id: `ws:${n.id}`,
    source: clientsId(n.id),
    target: serverId(n.id),
    node: n.id,
  }));
  if (leader) {
    for (const [lane, f] of followers.entries())
      links.push({
        kind: "stream",
        id: `stream:${f.id}`,
        source: serverId(leader.id),
        target: serverId(f.id),
        node: f.id,
        lane,
      });
    links.push({ kind: "store", id: "commits", source: serverId(leader.id), target: STORE_ID, node: leader.id });
  }
  const placed: Placed[] = [];
  if (mode === "narrow") {
    const x = NARROW_LANES;
    let y = 0;
    const down = (h: number) => {
      const top = y;
      y += h + NARROW_GAP;
      return top;
    };
    for (const n of followers.length ? followers : serving) {
      placed.push({ kind: "clients", id: clientsId(n.id), x, y: down(H.clients), node: n.id });
      if (n.role === "follower") placed.push({ kind: "server", id: serverId(n.id), x, y: down(H.server), node: n.id });
    }
    if (leader) placed.push({ kind: "server", id: serverId(leader.id), x, y: down(H.server), node: leader.id });
    placed.push({ kind: "store", id: STORE_ID, x, y: down(H.store) });
    return { placed, links, width: x + NODE_W };
  }
  const single = followers.length === 0;
  const width = Math.max(1, serving.length) * (NODE_W + GAP_X) - GAP_X;
  const centre = (width - NODE_W) / 2;
  const column = (i: number) => i * (NODE_W + GAP_X);
  const row = single ? ROW_SINGLE : ROW;
  serving.forEach((n, i) => {
    placed.push({ kind: "clients", id: clientsId(n.id), x: column(i), y: row.clients, node: n.id });
  });
  followers.forEach((n, i) => {
    placed.push({ kind: "server", id: serverId(n.id), x: column(i), y: ROW.followers, node: n.id });
  });
  if (leader) placed.push({ kind: "server", id: serverId(leader.id), x: centre, y: row.leader, node: leader.id });
  placed.push({ kind: "store", id: STORE_ID, x: centre, y: row.store });
  return { placed, links, width };
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
