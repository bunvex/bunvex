// Where each table sits (STUDY-12 §14): ELK's layered layout, top to bottom, as Convex's schema view uses
// (`features/schema/lib/elkLayout.ts`); groups are laid out inside their own box. ELK is loaded on first use, in
// the Schema screen's chunk only.
import type { Cluster } from "./clusters.ts";
import type { SchemaGraph, SchemaNode } from "./graph.ts";

export const NODE_WIDTH = 272;
const HEADER = 44;
const ROW = 26;
/** Rows a node shows before "N more"; the side panel has them all. */
export const MAX_ROWS = 12;
/** Indexes a node lists before "N more indexes", as Convex's `MAX_VISIBLE_INDEXES`. */
export const MAX_INDEXES = 5;
const INDEX_HEADER = 28;

export type Size = { width: number; height: number };
export type Box = { x: number; y: number; width: number; height: number };
export type Layout = { nodes: Record<string, Box>; clusters: Record<string, Box> };

/** The indexes a table card lists: its own, not the system ones (`by_id`, `by_creation_time`), as Convex. */
export const userIndexes = (n: SchemaNode) => n.indexes.filter((ix) => !ix.system);

export function nodeSize(n: SchemaNode): Size {
  const rows = Math.max(1, Math.min(n.fields.length, MAX_ROWS) + (n.fields.length > MAX_ROWS ? 1 : 0));
  const ix = userIndexes(n).length;
  const indexRows = ix === 0 ? 0 : INDEX_HEADER + (Math.min(ix, MAX_INDEXES) + (ix > MAX_INDEXES ? 1 : 0)) * ROW + 4;
  return { width: NODE_WIDTH, height: HEADER + rows * ROW + 8 + indexRows };
}

type ElkNode = {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  children?: ElkNode[];
  edges?: { id: string; sources: string[]; targets: string[] }[];
  layoutOptions?: Record<string, string>;
};
type Elk = { layout: (graph: ElkNode) => Promise<ElkNode> };

let elk: Promise<Elk> | undefined;
const getElk = () => (elk ??= import("elkjs/lib/elk.bundled.js").then((m) => new m.default() as unknown as Elk));

const ROOT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.spacing.nodeNode": "56",
  "elk.layered.spacing.nodeNodeBetweenLayers": "96",
  "elk.spacing.componentComponent": "72",
  "elk.spacing.edgeNode": "24",
};
export const CLUSTER_TOP = 40;
// a group box lays its tables out with the same spacing as the root: ELK reads spacing per parent, and
// without it the tables inside sat 20 px apart, their reference lines squeezed along the cards' borders
const CLUSTER_OPTIONS = {
  ...ROOT_OPTIONS,
  "elk.padding": `[top=${CLUSTER_TOP},left=20,bottom=20,right=20]`,
};

/** Positions for every table (and group box), absolute. */
export async function computeLayout(graph: SchemaGraph, clusters: Cluster[] = []): Promise<Layout> {
  const out: Layout = { nodes: {}, clusters: {} };
  if (graph.nodes.length === 0) return out;
  const leaf = (n: SchemaNode): ElkNode => ({ id: n.table, ...nodeSize(n) });
  const inCluster = new Map(clusters.flatMap((c) => c.tables.map((t) => [t, c.id] as const)));
  const byName = new Map(graph.nodes.map((n) => [n.table, n]));
  const root: ElkNode = {
    id: "root",
    layoutOptions: ROOT_OPTIONS,
    children: [
      ...clusters.map((c) => ({
        id: c.id,
        layoutOptions: CLUSTER_OPTIONS,
        children: c.tables.map((t) => leaf(byName.get(t)!)),
      })),
      ...graph.nodes.filter((n) => !inCluster.has(n.table)).map(leaf),
    ],
    edges: graph.edges
      .filter((e) => e.source !== e.target)
      .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
  const laid = await (await getElk()).layout(root);
  const walk = (n: ElkNode, dx: number, dy: number) => {
    for (const c of n.children ?? []) {
      const box = { x: (c.x ?? 0) + dx, y: (c.y ?? 0) + dy, width: c.width ?? 0, height: c.height ?? 0 };
      if (c.children) {
        out.clusters[c.id] = box;
        walk(c, box.x, box.y);
      } else out.nodes[c.id] = box;
    }
  };
  walk(laid, 0, 0);
  return out;
}
