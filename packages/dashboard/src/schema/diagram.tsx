// The schema diagram (STUDY-12 §14), drawn with xyflow and laid out with ELK as Convex's is
// (`features/schema/components/SchemaFlow.tsx`, `TableNode.tsx`, `SchemaClusters.tsx`, `SchemaSearch.tsx`,
// `SchemaMinimap.tsx`, `SchemaControls.tsx`): a node per table, an arrow per reference, related tables boxed
// together (a toggle, kept per deployment), a search over groups, tables, fields and indexes, a minimap, zoom and
// pan. A table opens in the side panel (`?table=`), by a click or by Enter on its focused node.
import "@xyflow/react/dist/style.css";
import { Button } from "@bunvex/ui/components/button";
import { Input } from "@bunvex/ui/components/input";
import {
  type Edge,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { GripVertical, Link2, ListTree, Pencil, RotateCcw, Table2 } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueryScope } from "../context.tsx";
import { type SchemaSearch, schemaRoute } from "../router.tsx";
import { formatCount } from "../screens/stats.ts";
import { FlowBackground, FlowControls } from "../shell/flow-controls.tsx";
import { type Cluster, computeClusters } from "./clusters.ts";
import type { SchemaGraph, SchemaNode } from "./graph.ts";
import { CLUSTER_TOP, computeLayout, type Layout, MAX_INDEXES, MAX_ROWS, userIndexes } from "./layout.ts";
import { TablePanel } from "./panel.tsx";
import { readSavedLayout, type SavedLayout, savedPosition, writeSavedLayout } from "./saved-layout.ts";

type TableData = { node: SchemaNode; dimmed: boolean; linked: boolean; flash: boolean };

/** Go to a referenced table: what a card's `Id<"t">` type does (set by the diagram). */
const GoToContext = createContext<(table: string) => void>(() => {});
type GroupData = { label: string; count: number; onRename: (name: string) => void };
type FlowNode = Node<TableData, "table"> | Node<GroupData, "cluster">;

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const isDark = () => document.documentElement.classList.contains("dark");

/** The page's theme, followed as it changes (the host owns it: a `.dark` class on <html>). */
function useDark(): boolean {
  const [dark, setDark] = useState(isDark);
  useEffect(() => {
    const o = new MutationObserver(() => setDark(isDark()));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => o.disconnect();
  }, []);
  return dark;
}

function TableNodeView({ data, selected }: NodeProps<Node<TableData, "table">>) {
  const { node } = data;
  const shown = node.fields.slice(0, MAX_ROWS);
  const indexes = userIndexes(node);
  const goTo = useContext(GoToContext);
  return (
    <div
      className={[
        "w-[272px] border bg-card text-card-foreground shadow-sm transition-opacity",
        selected ? "border-primary ring-2 ring-primary/40" : data.linked ? "border-primary/60" : "",
        data.flash ? "ring-4 ring-info" : "",
        data.dimmed ? "opacity-35" : "",
      ].join(" ")}
    >
      <Handle type="target" position={Position.Top} className="!size-1.5 !min-w-0 !border-0 !bg-muted-foreground" />
      <div className="flex h-11 items-center gap-2 border-b px-3">
        <Table2 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-sm font-semibold">{node.table}</span>
        {node.notInSchema && (
          <span
            title="This table holds documents but is not declared in the schema."
            className="shrink-0 text-xs text-warning"
          >
            not in schema
          </span>
        )}
        {node.documentCount !== undefined && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatCount(node.documentCount)}</span>
        )}
      </div>
      <ul className="py-1 font-mono text-xs">
        {node.untyped && <li className="h-[26px] px-3 leading-[26px] text-muted-foreground">any fields</li>}
        {shown.map((f) => (
          <li key={f.name} className="flex h-[26px] items-center gap-2 px-3">
            <span className="min-w-0 shrink truncate">
              {f.name}
              {f.optional && <span className="text-muted-foreground">?</span>}
            </span>
            {f.references.length > 0 && <Link2 aria-hidden="true" className="size-3 shrink-0 text-primary" />}
            {f.references.length > 0 ? (
              // a reference goes to its table, as Convex's: the type is the link
              <button
                type="button"
                title={f.fullType ?? f.type}
                aria-label={`${f.name}: ${f.type}, go to table ${f.references[0]}`}
                className="nodrag nopan ml-auto min-w-0 cursor-pointer truncate text-right text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-1 focus-visible:ring-ring"
                onClick={(e) => {
                  e.stopPropagation();
                  goTo(f.references[0]!);
                }}
              >
                {f.type}
              </button>
            ) : (
              <span title={f.fullType ?? f.type} className="ml-auto min-w-0 truncate text-right text-muted-foreground">
                {f.type}
              </span>
            )}
          </li>
        ))}
        {node.fields.length > MAX_ROWS && (
          <li className="h-[26px] px-3 leading-[26px] text-muted-foreground">
            {node.fields.length - MAX_ROWS} more fields
          </li>
        )}
      </ul>
      {indexes.length > 0 && (
        <div className="border-t pb-1" data-indexes="">
          <p className="px-3 text-xs leading-7 text-muted-foreground">Indexes</p>
          <ul className="font-mono text-xs">
            {indexes.slice(0, MAX_INDEXES).map((ix) => (
              <li key={ix.name} className="flex h-[26px] items-center gap-2 px-3">
                <ListTree aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 shrink truncate">{ix.name}</span>
                <span className="ml-auto min-w-0 truncate text-right text-muted-foreground">
                  {ix.fields.join(", ")}
                </span>
              </li>
            ))}
            {indexes.length > MAX_INDEXES && (
              <li className="h-[26px] px-3 leading-[26px] text-muted-foreground">
                +{indexes.length - MAX_INDEXES} more {indexes.length - MAX_INDEXES === 1 ? "index" : "indexes"}
              </li>
            )}
          </ul>
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!size-1.5 !min-w-0 !border-0 !bg-muted-foreground" />
    </div>
  );
}

/** A group's box: its header drags the whole group (`dragHandle`), and its name can be changed in place. */
function GroupView({ data }: NodeProps<Node<GroupData, "cluster">>) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(data.label);
  useEffect(() => setName(data.label), [data.label]);
  // a browser may blur the box as it goes away: only the first way out counts (Escape must not save)
  const closed = useRef(false);
  const done = (save: boolean) => {
    if (closed.current) return;
    closed.current = true;
    if (save) data.onRename(name.trim());
    setEditing(false);
  };
  const open = () => {
    closed.current = false;
    setEditing(true);
  };
  return (
    <div className="pointer-events-none size-full border border-dashed border-muted-foreground/40 bg-muted/30">
      <div
        className="schema-group-handle pointer-events-auto flex cursor-grab items-center gap-1 px-2 text-xs font-medium text-muted-foreground active:cursor-grabbing"
        style={{ height: CLUSTER_TOP }}
      >
        <GripVertical aria-hidden="true" className="size-3.5 shrink-0" />
        {editing ? (
          <Input
            // nodrag: typing and selecting text in the box must not drag the group
            className="nodrag h-6 w-40 text-xs"
            aria-label={`Name of the group ${data.label}`}
            // biome-ignore lint/a11y/noAutofocus: the box opens on the reader's request, to type in
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") done(true);
              if (e.key === "Escape") done(false);
            }}
            onBlur={() => done(true)}
          />
        ) : (
          <>
            <span className="truncate">{data.label}</span>
            <span className="shrink-0 tabular-nums">· {data.count} tables</span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="nodrag ml-1"
              aria-label={`Rename the group ${data.label}`}
              onClick={open}
            >
              <Pencil aria-hidden="true" />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

const nodeTypes = { table: TableNodeView, cluster: GroupView };

/** What the search finds: groups, tables, fields ("table.field") and indexes ("table index"). */
type Hit = { key: string; label: string; detail: string; table: string };
function search(graph: SchemaGraph, clusters: Cluster[], query: string): Hit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: Hit[] = [];
  for (const c of clusters)
    if (c.label.toLowerCase().includes(q))
      hits.push({ key: c.id, label: c.label, detail: `group of ${c.tables.length}`, table: c.label });
  for (const n of graph.nodes) {
    if (n.table.toLowerCase().includes(q))
      hits.push({ key: `t:${n.table}`, label: n.table, detail: "table", table: n.table });
    for (const f of n.fields)
      if (f.name.toLowerCase().includes(q))
        hits.push({ key: `f:${n.table}.${f.name}`, label: `${n.table}.${f.name}`, detail: f.type, table: n.table });
    for (const ix of n.indexes)
      if (!ix.system && ix.name.toLowerCase().includes(q))
        hits.push({ key: `i:${n.table}.${ix.name}`, label: `${n.table}.${ix.name}`, detail: "index", table: n.table });
  }
  return hits.slice(0, 12);
}

function groupsKey(scope: string) {
  return `bunvex:schema-groups:${scope}`;
}
function readGroups(scope: string): boolean {
  try {
    return localStorage.getItem(groupsKey(scope)) !== "off";
  } catch {
    return true;
  }
}

function Diagram({ graph, heading, status }: { graph: SchemaGraph; heading: ReactNode; status?: ReactNode }) {
  const { scope } = useQueryScope();
  const search$ = schemaRoute.useSearch();
  const navigate = schemaRoute.useNavigate();
  const selected = search$.table && graph.nodes.some((n) => n.table === search$.table) ? search$.table : undefined;
  const select = useCallback(
    (table: string | undefined) => void navigate({ search: (s: SchemaSearch): SchemaSearch => ({ ...s, table }) }),
    [navigate],
  );
  const flow = useReactFlow();
  const dark = useDark();
  const [grouped, setGrouped] = useState(() => readGroups(scope));
  // names and dragged positions kept in this browser (SC1); applied over the computed layout
  const [saved, setSaved] = useState<SavedLayout>(() => readSavedLayout(scope));
  const save = useCallback(
    (next: SavedLayout) => {
      setSaved(next);
      writeSavedLayout(scope, next);
    },
    [scope],
  );
  const rename = useCallback(
    (id: string, name: string) => {
      const names = { ...saved.names };
      if (name) names[id] = name;
      else delete names[id]; // an empty name gives the group its own back
      save({ ...saved, names });
    },
    [saved, save],
  );
  const computed = useMemo(() => (grouped ? computeClusters(graph) : []), [graph, grouped]);
  const clusters = useMemo(
    () => computed.map((c) => ({ ...c, label: saved.names[c.id] ?? c.label })),
    [computed, saved.names],
  );
  const [layout, setLayout] = useState<Layout>();
  const [query, setQuery] = useState("");
  /** A table lit a moment after going to it. */
  const [flash, setFlash] = useState<string>();
  const hits = useMemo(() => search(graph, clusters, query), [graph, clusters, query]);
  const matching = useMemo(() => (query.trim() ? new Set(hits.map((h) => h.table)) : undefined), [hits, query]);
  const searchId = useId();
  const listRef = useRef<HTMLUListElement>(null);

  // lay out again when the tables, their fields or the grouping change
  const [generation, setGeneration] = useState(0);
  const [laying, setLaying] = useState(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new `generation` (Reset layout) lays out again
  useEffect(() => {
    let live = true;
    setLaying(true);
    void computeLayout(graph, computed).then((l) => {
      if (!live) return;
      setLayout(l);
      setLaying(false);
    });
    return () => {
      live = false;
    };
  }, [graph, computed, generation]);

  const linked = useMemo(() => {
    const s = new Set<string>();
    if (selected)
      for (const e of graph.edges) {
        if (e.source === selected) s.add(e.target);
        if (e.target === selected) s.add(e.source);
      }
    return s;
  }, [graph, selected]);

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  useEffect(() => {
    if (!layout) return;
    const parentOf = new Map(clusters.flatMap((c) => c.tables.map((t) => [t, c.id] as const)));
    const groups: FlowNode[] = clusters.map((c) => {
      const b = layout.clusters[c.id]!;
      return {
        id: c.id,
        type: "cluster",
        position: savedPosition(saved, c.id, null) ?? { x: b.x, y: b.y },
        width: b.width,
        height: b.height,
        data: { label: c.label, count: c.tables.length, onRename: (name) => rename(c.id, name) },
        // the header drags the whole group: its tables are its children and move with it
        dragHandle: ".schema-group-handle",
        selectable: false,
        focusable: false,
        zIndex: -1,
      };
    });
    const tables: FlowNode[] = graph.nodes.map((n) => {
      const b = layout.nodes[n.table]!;
      const parent = parentOf.get(n.table) ?? null;
      const box = parent ? layout.clusters[parent]! : undefined;
      // inside a group, a table's position is relative to the group's box
      const computedPos = box ? { x: b.x - box.x, y: b.y - box.y } : { x: b.x, y: b.y };
      const refs = graph.edges.filter((e) => e.source === n.table).map((e) => e.target);
      return {
        id: n.table,
        type: "table",
        ...(parent && { parentId: parent }),
        position: savedPosition(saved, n.table, parent) ?? computedPos,
        width: b.width,
        height: b.height,
        data: { node: n, dimmed: false, linked: false, flash: false },
        ariaLabel: `Table ${n.table}: ${n.fields.length} fields${refs.length ? `, references ${[...new Set(refs)].join(", ")}` : ""}${n.notInSchema ? ", not in the schema" : ""}`,
      };
    });
    setNodes([...groups, ...tables]);
  }, [layout, graph, clusters, saved, rename, setNodes]);

  // dimming and selection follow the search and the URL without moving anything
  const shown = useMemo(
    () =>
      nodes.map((n): FlowNode => {
        if (n.type !== "table") return n;
        return {
          ...n,
          selected: n.id === selected,
          data: {
            ...n.data,
            dimmed: matching ? !matching.has(n.id) : false,
            linked: linked.has(n.id),
            flash: n.id === flash,
          },
        };
      }),
    [nodes, selected, matching, linked, flash],
  );

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((e) => {
        const on = selected !== undefined && (e.source === selected || e.target === selected);
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: "smoothstep",
          ariaLabel: `${e.source}.${e.field} references ${e.target}`,
          label: on ? e.field : undefined,
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
          style: {
            stroke: on ? "var(--color-primary)" : "var(--color-muted-foreground)",
            strokeWidth: on ? 2 : 1.25,
            strokeDasharray: e.optional ? "5 4" : undefined,
            opacity: matching && !(matching.has(e.source) && matching.has(e.target)) ? 0.25 : 1,
          },
          zIndex: on ? 1 : 0,
        };
      }),
    [graph, selected, matching],
  );

  const duration = reducedMotion() ? 0 : 300;
  // fit once the first layout is in place
  const fitted = useRef(false);
  useEffect(() => {
    if (!layout || fitted.current || nodes.length === 0) return;
    fitted.current = true;
    // never past 100 %: a small schema would otherwise fill the canvas with oversized cards
    requestAnimationFrame(() => void flow.fitView({ padding: 0.15, maxZoom: 1, duration: 0 }));
  }, [layout, nodes.length, flow]);

  // go to a referenced table: pan to it, light it a moment, give it the focus (instant under reduced motion)
  const goTo = useCallback(
    (table: string) => {
      void flow.fitView({ nodes: [{ id: table }], padding: 0.6, maxZoom: 1, duration });
      setFlash(table);
      setTimeout(() => setFlash((f) => (f === table ? undefined : f)), 1200);
      setTimeout(
        () => document.querySelector<HTMLElement>(`.react-flow__node-table[data-id="${CSS.escape(table)}"]`)?.focus(),
        duration,
      );
    },
    [flow, duration],
  );
  /** From the panel (a reference, a search hit): open the table too. */
  const focusTable = (table: string) => {
    select(table);
    goTo(table);
  };

  return (
    <div className="-m-4 flex h-[calc(100svh-3rem)] min-h-[28rem] md:-m-6">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Bar 1 (UI-01 §22.5): 44 px, on the docked panel header's line */}
        <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-1 md:px-6">
          {heading}
          <span className="text-sm text-muted-foreground tabular-nums">
            {formatCount(graph.nodes.length)} tables · {formatCount(graph.edges.length)} references
          </span>
          <span role="status" className="text-sm text-muted-foreground">
            {laying ? "Laying out…" : ""}
          </span>
          {status}
          <div className="relative ml-auto w-full sm:w-72">
            <label htmlFor={searchId} className="sr-only">
              Search groups, tables, fields and indexes
            </label>
            <Input
              className="h-7"
              id={searchId}
              type="search"
              placeholder="Search tables, fields, indexes…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  listRef.current?.querySelector("button")?.focus();
                } else if (e.key === "Enter" && hits[0]) focusTable(hits[0].table);
              }}
              aria-controls={query.trim() ? `${searchId}-hits` : undefined}
            />
            {query.trim() && (
              <ul
                id={`${searchId}-hits`}
                ref={listRef}
                aria-label="Search results"
                className="absolute inset-x-0 top-full z-20 mt-1 max-h-80 overflow-y-auto border bg-popover p-1 shadow-md"
              >
                {hits.length === 0 && <li className="px-2 py-1.5 text-sm text-muted-foreground">Nothing matches.</li>}
                {hits.map((h) => (
                  <li key={h.key}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                      onClick={() => focusTable(h.table)}
                      onKeyDown={(e) => {
                        const items = [...(listRef.current?.querySelectorAll("button") ?? [])];
                        const i = items.indexOf(e.currentTarget);
                        if (e.key === "ArrowDown") items[i + 1]?.focus();
                        else if (e.key === "ArrowUp") (items[i - 1] ?? document.getElementById(searchId))?.focus();
                        else if (e.key === "Escape") document.getElementById(searchId)?.focus();
                        else return;
                        e.preventDefault();
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate font-mono">{h.label}</span>
                      <span className="shrink-0 truncate text-xs text-muted-foreground">{h.detail}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <section
          aria-label="Schema diagram"
          className="relative min-h-0 flex-1"
          // Enter or Space on a focused table opens it (the URL, not xyflow's selection, says which is open)
          onKeyDown={(e) => {
            const id = (e.target as HTMLElement).closest(".react-flow__node-table")?.getAttribute("data-id");
            if (id && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              select(id);
            }
          }}
        >
          <GoToContext.Provider value={goTo}>
            <ReactFlow
              nodes={shown}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onNodeDragStop={(_, __, dragged) => {
                const positions = { ...saved.positions };
                for (const n of dragged)
                  positions[n.id] = { x: n.position.x, y: n.position.y, parent: n.parentId ?? null };
                save({ ...saved, positions });
              }}
              onNodeClick={(_, n) => n.type === "table" && select(n.id)}
              onPaneClick={() => selected && select(undefined)}
              colorMode={dark ? "dark" : "light"}
              minZoom={0.1}
              maxZoom={2}
              nodesConnectable={false}
              edgesFocusable={false}
              elementsSelectable={false}
              nodesFocusable
              onlyRenderVisibleElements={graph.nodes.length > 60}
              proOptions={{ hideAttribution: true }}
              className="[--xy-background-color:var(--color-background)] [--xy-edge-label-background-color:var(--color-background)] [--xy-edge-label-color:var(--color-foreground)] [--xy-minimap-background-color:var(--color-card)] [--xy-node-border-radius:0]"
            >
              <FlowBackground />
              <MiniMap
                pannable
                zoomable
                ariaLabel="Minimap of the schema"
                nodeColor={(n) =>
                  n.type === "cluster"
                    ? "transparent"
                    : n.id === selected
                      ? "var(--color-primary)"
                      : "var(--color-muted-foreground)"
                }
                nodeStrokeColor={(n) => (n.type === "cluster" ? "var(--color-border)" : "transparent")}
                maskColor="color-mix(in oklab, var(--color-background) 70%, transparent)"
                className="!hidden border md:!block"
              />
              <FlowControls
                onZoomIn={() => void flow.zoomIn({ duration })}
                onZoomOut={() => void flow.zoomOut({ duration })}
                onFit={() => void flow.fitView({ padding: 0.15, maxZoom: 1, duration })}
              >
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Reset layout"
                  onClick={() => {
                    // forgets where tables and groups were dragged; names stay
                    save({ ...saved, positions: {} });
                    setGeneration((g) => g + 1);
                  }}
                >
                  <RotateCcw aria-hidden="true" />
                </Button>
                <label className="flex items-center gap-1.5 px-2 text-xs">
                  <input
                    type="checkbox"
                    checked={grouped}
                    onChange={(e) => {
                      setGrouped(e.target.checked);
                      try {
                        localStorage.setItem(groupsKey(scope), e.target.checked ? "on" : "off");
                      } catch {
                        // storage off: the choice lasts for this visit
                      }
                    }}
                  />
                  Group related tables
                </label>
              </FlowControls>
            </ReactFlow>
          </GoToContext.Provider>
        </section>
      </div>
      {selected && (
        <TablePanel
          node={graph.nodes.find((n) => n.table === selected)!}
          graph={graph}
          onOpen={focusTable}
          onClose={() => select(undefined)}
        />
      )}
    </div>
  );
}

export function SchemaDiagram(props: { graph: SchemaGraph; heading: ReactNode; status?: ReactNode }) {
  return (
    <ReactFlowProvider>
      <Diagram {...props} />
    </ReactFlowProvider>
  );
}
