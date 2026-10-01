// Groups of related tables, boxed and labelled on the diagram (STUDY-12 §14), as Convex's schema view groups them
// (`features/schema/lib/clustering.ts`): tables linked to each other but not to the rest form a group; a large
// linked group is split by modularity (Louvain's local moving), so dense neighbourhoods stay together. A group is
// named after its most linked table.
import type { SchemaGraph } from "./graph.ts";

export type Cluster = {
  /** Stable for a given set of members. */
  id: string;
  label: string;
  /** Sorted. */
  tables: string[];
};

export type ClusterOptions = {
  /** A linked group smaller than this stays one group. */
  minSizeToSplit?: number;
  /** Louvain's resolution: higher gives more, smaller groups. */
  resolution?: number;
};

type Adjacency = Map<string, Map<string, number>>;

function adjacency(graph: SchemaGraph): Adjacency {
  const adj: Adjacency = new Map(graph.nodes.map((n) => [n.table, new Map()]));
  for (const e of graph.edges) {
    if (e.source === e.target) continue;
    const a = adj.get(e.source)!;
    const b = adj.get(e.target)!;
    a.set(e.target, (a.get(e.target) ?? 0) + 1);
    b.set(e.source, (b.get(e.source) ?? 0) + 1);
  }
  return adj;
}

function components(adj: Adjacency): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const start of [...adj.keys()].sort()) {
    if (seen.has(start)) continue;
    const group: string[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const t = stack.pop()!;
      group.push(t);
      for (const n of adj.get(t)!.keys())
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
    }
    out.push(group.sort());
  }
  return out;
}

/** One level of Louvain's local moving over `members`: each table joins the neighbour group that gains most. */
function communities(members: string[], adj: Adjacency, resolution: number): string[][] {
  const degree = new Map(members.map((t) => [t, [...adj.get(t)!.values()].reduce((a, b) => a + b, 0)]));
  const m2 = [...degree.values()].reduce((a, b) => a + b, 0); // twice the edge weight
  if (m2 === 0) return [members];
  const group = new Map(members.map((t) => [t, t]));
  const total = new Map(members.map((t) => [t, degree.get(t)!])); // sum of degrees per group
  for (let pass = 0, moved = true; moved && pass < 20; pass++) {
    moved = false;
    for (const t of members) {
      const from = group.get(t)!;
      const k = degree.get(t)!;
      const links = new Map<string, number>();
      for (const [n, w] of adj.get(t)!) links.set(group.get(n)!, (links.get(group.get(n)!) ?? 0) + w);
      total.set(from, total.get(from)! - k);
      let best = from;
      let bestGain = (links.get(from) ?? 0) - (resolution * total.get(from)! * k) / m2;
      for (const [g, w] of [...links].sort(([a], [b]) => a.localeCompare(b))) {
        const gain = w - (resolution * total.get(g)! * k) / m2;
        if (gain > bestGain + 1e-9) {
          best = g;
          bestGain = gain;
        }
      }
      total.set(best, total.get(best)! + k);
      if (best !== from) {
        group.set(t, best);
        moved = true;
      }
    }
  }
  const out = new Map<string, string[]>();
  for (const t of members) out.set(group.get(t)!, [...(out.get(group.get(t)!) ?? []), t]);
  return [...out.values()].map((g) => g.sort());
}

/** The most linked table of a group (ties: alphabetical). */
function nucleus(tables: string[], adj: Adjacency): string {
  const inside = new Set(tables);
  const score = (t: string) => [...adj.get(t)!].reduce((s, [n, w]) => s + (inside.has(n) ? w : 0), 0);
  return [...tables].sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0]!;
}

/** The groups worth boxing: two tables or more. */
export function computeClusters(graph: SchemaGraph, opts: ClusterOptions = {}): Cluster[] {
  const { minSizeToSplit = 8, resolution = 1 } = opts;
  const adj = adjacency(graph);
  const groups = components(adj).flatMap((c) => (c.length >= minSizeToSplit ? communities(c, adj, resolution) : [c]));
  return groups
    .filter((g) => g.length >= 2)
    .map((tables) => ({ id: `cluster:${tables.join(",")}`, label: nucleus(tables, adj), tables }));
}
