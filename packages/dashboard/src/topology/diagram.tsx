// The Topology screen's diagram (UI-01 §22): a canvas in fixed layers (layout.ts) — the clients of each
// serving node, the followers, the leader, the store — with icons and compact node cards (each server card
// ends in a strip for the node's own query cache), and edges that say what flows: WebSockets, the commit
// stream (its lag in words and colour, its width by commits per second, particles moving along it unless the
// reader prefers reduced motion) and the leader's commits to the store, where it holds the lease. Hovering a
// node (or picking one of the feed's events) lights its edges and dims the rest; a click or Enter opens its
// details. On a phone the layout is one column, framed to the canvas's width and panned vertically. Drawn
// with React Flow, as the Schema screen is.
import "@xyflow/react/dist/style.css";
import { Button } from "@bunvex/ui/components/button";
import { cn } from "@bunvex/ui/lib/utils";
import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  getSmoothStepPath,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import { Crown, Database, Lock, MemoryStick, MonitorSmartphone, Server, Tags } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type ClientGroup, PlatformIcon } from "../clients/words.tsx";
import type { NodeCache, Topology, TopologyNode, TopologyStore } from "../data-source.ts";
import { formatBytes, formatCount, formatPercent } from "../screens/stats.ts";
import { FlowBackground, FlowControls } from "../shell/flow-controls.tsx";
import { type LayoutMode, type Link, layoutTopology, neighbourhood, STORE_ID, serverId } from "./layout.ts";
import { LagGauge, StateLabel } from "./parts.tsx";
import { compact, DRIVER, lagText, servesClients } from "./words.ts";

const isDark = () => document.documentElement.classList.contains("dark");
function useDark(): boolean {
  const [dark, setDark] = useState(isDark);
  useEffect(() => {
    const o = new MutationObserver(() => setDark(isDark()));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => o.disconnect();
  }, []);
  return dark;
}

/** Whether the reader asked for less motion: then no particles, and no animated framing. */
export function useReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const m = matchMedia(query);
    const on = () => setReduced(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

/** What every node and edge reads besides its own data: what is lit, and how. */
type Look = { lit: Set<string> | null; labels: boolean; reduced: boolean; mode: LayoutMode };
const LookContext = createContext<Look>({ lit: null, labels: true, reduced: false, mode: "wide" });
const dimmed = (look: Look, id: string) => look.lit !== null && !look.lit.has(id);

// ------------------------------------------------------------------ nodes

type ClientsData = { node: string; connections: number };
type GroupData = { group: ClientGroup; opened: boolean };
type ServerData = { node: TopologyNode; topology: Topology; opened: boolean };
type StoreData = { store: TopologyStore };

const CARD = "w-[220px] border bg-card text-card-foreground text-xs leading-4 transition-opacity";
const HANDLE = "!size-1.5 !min-h-0 !min-w-0 !border-0 !bg-border";
const MUTED = "text-muted-foreground";

function Bar({ value, warn = 0.85, className }: { value: number | null; warn?: number; className?: string }) {
  const v = Math.min(1, Math.max(0, value ?? 0));
  return (
    <span aria-hidden="true" className={cn("block h-[3px] bg-muted", className ?? "min-w-6 flex-1")}>
      <span
        className={cn("block h-full", v > warn ? "bg-warning" : "bg-muted-foreground/50")}
        style={{ width: `${Math.round(v * 100)}%` }}
      />
    </span>
  );
}

/** A vital: its name and value on one line, its share of the limit as a thin bar under them. */
function Meter({ label, text, value }: { label: string; text: string; value: number | null }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="flex justify-between gap-2">
        <span className={MUTED}>{label}</span>
        <span className="font-mono tabular-nums">{text}</span>
      </span>
      <Bar value={value} className="w-full" />
    </span>
  );
}

function ClientsNode({ id, data }: NodeProps<Node<ClientsData, "clients">>) {
  const look = useContext(LookContext);
  return (
    <div className={cn(CARD, "flex items-center gap-2 border-dashed px-3 py-2", dimmed(look, id) && "opacity-30")}>
      <MonitorSmartphone aria-hidden="true" className={cn("size-4 shrink-0", MUTED)} />
      <span className="font-mono text-sm tabular-nums">{formatCount(data.connections)}</span>
      <span className={MUTED}>clients</span>
      <Handle type="source" position={Position.Bottom} className={HANDLE} isConnectable={false} />
    </div>
  );
}

/** A client group (UI-01 §33): a platform or a registered app, its live connections; on a phone, its nodes. */
function GroupNode({ id, data }: NodeProps<Node<GroupData, "clientgroup">>) {
  const look = useContext(LookContext);
  const g = data.group;
  return (
    <div
      className={cn(
        CARD,
        "flex flex-col gap-0.5 border-dashed px-3 py-2",
        look.mode === "wide" && "w-[168px]",
        data.opened && "ring-2 ring-ring",
        dimmed(look, id) && "opacity-30",
      )}
      data-client-group={g.key}
    >
      <div className="flex items-center gap-2">
        <PlatformIcon platform={g.platform} className="size-4" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={g.label}>
          {g.label}
        </span>
        <span className="font-mono text-sm tabular-nums">{formatCount(g.connections)}</span>
      </div>
      {look.mode === "narrow" && (
        <span className={MUTED}>{g.perNode.map((p) => `${p.node} ${formatCount(p.connections)}`).join(" · ")}</span>
      )}
      <Handle type="source" position={Position.Bottom} className={HANDLE} isConnectable={false} />
    </div>
  );
}

/** The node's own query cache in one line: hit rate, LRU occupancy and invalidations per second. */
export function CacheStrip({ cache: c }: { cache: NodeCache }) {
  return (
    <div className="flex items-center gap-1.5 border-t px-3 py-1.5" data-cache-strip="">
      <span className={MUTED}>Cache</span>
      <span className="font-mono tabular-nums">{c.hitRate === null ? "—" : `${Math.round(c.hitRate * 100)}%`}</span>
      <Bar value={c.entries / c.maxEntries} warn={0.95} />
      <span className="font-mono tabular-nums">
        {compact(c.entries)}/{compact(c.maxEntries)}
      </span>
      <span className={cn("font-mono tabular-nums", MUTED)}>{formatCount(c.invalidationsPerSecond)}/s</span>
    </div>
  );
}

function ServerNode({ id, data }: NodeProps<Node<ServerData, "server">>) {
  const look = useContext(LookContext);
  const { node: n, topology: t } = data;
  const leader = n.role === "leader";
  return (
    <div
      className={cn(
        CARD,
        "flex flex-col",
        leader && "border-foreground/30",
        data.opened && "ring-2 ring-ring",
        n.state === "down" && "opacity-70",
        dimmed(look, id) && "opacity-30",
      )}
    >
      <Handle id="in-top" type="target" position={Position.Top} className={HANDLE} isConnectable={false} />
      <Handle id="out-top" type="source" position={Position.Top} className={HANDLE} isConnectable={false} />
      <Handle id="in-left" type="target" position={Position.Left} className={HANDLE} isConnectable={false} />
      <Handle id="out-left" type="source" position={Position.Left} className={HANDLE} isConnectable={false} />
      <div className="flex flex-col gap-1.5 px-3 pt-2 pb-2">
        <div className="flex items-center gap-1.5">
          <Server aria-hidden="true" className={cn("size-3.5 shrink-0", MUTED)} />
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium">{n.id}</span>
          {leader && t.nodes.length > 1 && (
            <span className={cn("inline-flex items-center gap-0.5", MUTED)}>
              <Crown aria-hidden="true" className="size-3 text-warning" />
              Leader
            </span>
          )}
          <StateLabel state={n.state} />
        </div>
        {n.lag ? (
          <div className="flex flex-col gap-1">
            <span className={MUTED}>{lagText(n.lag)}</span>
            <LagGauge ms={n.lag.ms} state={n.state} />
          </div>
        ) : (
          <span className={MUTED}>
            {formatCount(n.commitsPerSecond ?? 0)} commits/s{n.scheduler && " · scheduler"}
          </span>
        )}
        <div className="grid grid-cols-2 gap-x-4">
          <Meter label="CPU" text={n.cpu === null ? "—" : formatPercent(n.cpu)} value={n.cpu} />
          <Meter
            label="Mem"
            text={n.memoryBytes === null ? "—" : formatBytes(n.memoryBytes)}
            value={n.memoryBytes !== null && n.memoryLimitBytes ? n.memoryBytes / n.memoryLimitBytes : null}
          />
        </div>
      </div>
      {n.cache && <CacheStrip cache={n.cache} />}
      <Handle id="in-bottom" type="target" position={Position.Bottom} className={HANDLE} isConnectable={false} />
      <Handle id="out-bottom" type="source" position={Position.Bottom} className={HANDLE} isConnectable={false} />
    </div>
  );
}

function StoreNode({ id, data }: NodeProps<Node<StoreData, "store">>) {
  const look = useContext(LookContext);
  const s = data.store;
  const Icon = s.driver === "memory" ? MemoryStick : Database;
  return (
    <div className={cn(CARD, "flex flex-col gap-1 px-3 py-2", dimmed(look, id) && "opacity-30")}>
      <Handle type="target" position={Position.Top} className={HANDLE} isConnectable={false} />
      <div className="flex items-center gap-1.5">
        <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", MUTED)} />
        <span className="flex-1 text-[13px] font-medium">{DRIVER[s.driver]}</span>
        <span className={MUTED}>store</span>
      </div>
      <span className={MUTED}>
        {s.singleNode
          ? "One node: a file lock keeps a second one out"
          : s.leaseHolder
            ? `Lease ${s.leaseHolder}${s.leaseTtlMs !== null ? ` · TTL ${Math.round(s.leaseTtlMs / 1000)} s` : ""}`
            : "No node holds the lease"}
      </span>
      {(s.latencyMs !== null || s.sizeBytes !== null) && (
        <span className="font-mono tabular-nums">
          {[s.latencyMs !== null && `${formatCount(s.latencyMs)} ms`, s.sizeBytes !== null && formatBytes(s.sizeBytes)]
            .filter(Boolean)
            .join(" · ")}
        </span>
      )}
    </div>
  );
}

// not "group": React Flow styles its own group nodes
const nodeTypes = { clients: ClientsNode, clientgroup: GroupNode, server: ServerNode, store: StoreNode };

// ------------------------------------------------------------------ edges

type FlowData = {
  kind: Link["kind"];
  label: string;
  /** normal, warning (lagging) or critical (down): stroke colour, said in the label too. */
  tone: "normal" | "warning" | "critical";
  width: number;
  /** Particles per edge and seconds per trip; 0 particles: none. */
  particles: number;
  trip: number;
  lock?: boolean;
  /** A client group's link: labelled only while lit, so many groups never bury the diagram in labels. */
  quiet?: boolean;
  /** Narrow layout: the stream's lane in the left margin. */
  lane?: number;
  lanes?: number;
};

const TONE = {
  normal: "var(--color-info)",
  warning: "var(--color-warning)",
  critical: "var(--color-destructive)",
} as const;

function FlowEdge(props: EdgeProps<Edge<FlowData, "flow">>) {
  const look = useContext(LookContext);
  const d = props.data!;
  const narrowStream = look.mode === "narrow" && d.kind === "stream";
  const step = Math.min(14, 56 / Math.max(1, d.lanes ?? 1));
  const [path, midX, midY] = narrowStream
    ? getSmoothStepPath({ ...props, borderRadius: 6, offset: 12 + (d.lane ?? 0) * step })
    : getBezierPath(props);
  // the commit streams all leave the leader's head: their labels sit near each follower instead, by column
  const near = d.kind === "stream" ? 0.74 : 0.5;
  const labelX = d.kind === "stream" ? props.sourceX + (props.targetX - props.sourceX) * near : midX;
  const labelY = d.kind === "stream" ? props.sourceY + (props.targetY - props.sourceY) * near : midY;
  const colour = d.kind === "clients" ? "var(--color-muted-foreground)" : TONE[d.tone];
  const faded = dimmed(look, props.id);
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        style={{
          stroke: colour,
          strokeWidth: d.width,
          strokeDasharray: d.kind === "clients" ? "3 4" : undefined,
          opacity: faded ? 0.12 : 0.85,
        }}
      />
      {!look.reduced &&
        !faded &&
        Array.from({ length: d.particles }, (_, i) => `${props.id}:${i}`).map((key, i) => (
          <circle key={key} r={Math.max(1.75, d.width * 0.8)} fill={colour} data-particle="">
            <animateMotion
              dur={`${d.trip}s`}
              // a negative start: every particle is already on its way, none waits at the origin
              begin={`-${(i * d.trip) / d.particles}s`}
              repeatCount="indefinite"
              path={path}
            />
          </circle>
        ))}
      {/* on a phone a stream's label would sit across the other lanes: its card says the lag */}
      {look.labels && !narrowStream && (!d.quiet || (look.lit !== null && !faded)) && (
        <EdgeLabelRenderer>
          <div
            className={cn(
              "nodrag nopan pointer-events-none absolute inline-flex items-center gap-1 border bg-background px-1 font-mono text-[11px] leading-4 text-muted-foreground tabular-nums transition-opacity",
              d.tone === "warning" && "border-warning text-foreground",
              d.tone === "critical" && "border-destructive text-destructive",
              faded && "opacity-20",
            )}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            data-edge-label={props.id}
          >
            {d.lock && <Lock aria-hidden="true" className="size-2.5" />}
            {d.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { flow: FlowEdge };

/** The commit stream's look from the leader's rate and the follower's state. */
export function streamLook(
  cps: number,
  follower: TopologyNode,
): Pick<FlowData, "tone" | "width" | "particles" | "trip"> {
  return {
    tone: follower.state === "down" ? "critical" : follower.state === "lagging" ? "warning" : "normal",
    width: 1.25 + Math.min(2.5, cps / 90),
    particles: follower.state === "down" ? 0 : Math.max(1, Math.min(5, Math.round(cps / 50))),
    trip: Math.max(1.2, 4 - cps / 100),
  };
}

// ------------------------------------------------------------------ the canvas

/** The picture as React Flow nodes and edges (exported for tests: happy-dom cannot measure, so draws no edge). */
export function toFlow(
  t: Topology,
  opened: string | undefined,
  mode: LayoutMode = "wide",
  groups?: ClientGroup[],
  openedGroup?: string,
) {
  const { placed, links: laid, width } = layoutTopology(t, mode, groups);
  // a phone draws no group links: each group's card names its nodes
  const links = mode === "narrow" ? laid.filter((l) => !(l.kind === "clients" && l.group)) : laid;
  const groupOf = new Map((groups ?? []).map((g) => [g.key, g]));
  const byId = new Map(t.nodes.map((n) => [n.id, n]));
  const leader = t.nodes.find((n) => n.role === "leader");
  const cps = leader?.commitsPerSecond ?? 0;
  const lanes = links.filter((l) => l.kind === "stream").length;
  const nodes: Node[] = placed.map((p) => {
    if (p.kind === "group") {
      const g = groupOf.get(p.key)!;
      return {
        id: p.id,
        type: "clientgroup",
        position: { x: p.x, y: p.y },
        ariaLabel: `${g.label}: ${formatCount(g.connections)} clients, on ${g.perNode.map((x) => `${x.node} ${formatCount(x.connections)}`).join(", ")}; press Enter for their versions`,
        data: { group: g, opened: openedGroup === g.key },
      };
    }
    if (p.kind === "clients") {
      const n = byId.get(p.node)!;
      return {
        id: p.id,
        type: "clients",
        position: { x: p.x, y: p.y },
        focusable: false,
        data: { node: n.id, connections: n.connections },
      };
    }
    if (p.kind === "server") {
      const n = byId.get(p.node)!;
      return {
        id: p.id,
        type: "server",
        position: { x: p.x, y: p.y },
        ariaLabel: [
          n.id,
          n.role === "leader" ? (t.nodes.length > 1 ? "leader" : "the only node") : "follower",
          n.state === "ok" ? "OK" : n.state,
          n.lag ? lagText(n.lag) : `${formatCount(n.commitsPerSecond ?? 0)} commits per second`,
          servesClients(n, t) ? `${formatCount(n.connections)} clients` : "",
          n.cache
            ? `cache ${n.cache.hitRate === null ? "unused" : `${formatPercent(n.cache.hitRate)} hits`}, ${formatCount(n.cache.entries)} of ${formatCount(n.cache.maxEntries)} entries`
            : "",
          "press Enter for details",
        ]
          .filter(Boolean)
          .join(", "),
        data: { node: n, topology: t, opened: opened === n.id },
      };
    }
    return { id: STORE_ID, type: "store", position: { x: p.x, y: p.y }, focusable: false, data: { store: t.store } };
  });
  const edges: Edge<FlowData>[] = links.map((l) => {
    const n = byId.get(l.node)!;
    if (l.kind === "clients" && l.group) {
      const count = groupOf.get(l.group)?.perNode.find((x) => x.node === l.node)?.connections ?? 0;
      return {
        id: l.id,
        source: l.source,
        target: l.target,
        type: "flow",
        targetHandle: "in-top",
        data: {
          kind: l.kind,
          label: `${formatCount(count)} ws`,
          tone: "normal",
          width: 1 + Math.min(2, count / 150),
          particles: 0,
          trip: 0,
          quiet: true,
        },
      };
    }
    if (l.kind === "clients")
      return {
        id: l.id,
        source: l.source,
        target: l.target,
        type: "flow",
        targetHandle: "in-top",
        data: {
          kind: l.kind,
          label: `${formatCount(n.connections)} ws`,
          tone: "normal",
          width: 1,
          particles: 0,
          trip: 0,
        },
      };
    if (l.kind === "stream") {
      const look = streamLook(cps, n);
      return {
        id: l.id,
        source: l.source,
        target: l.target,
        // wide: up from the leader into the follower's foot; narrow: along the left margin
        sourceHandle: mode === "narrow" ? "out-left" : "out-top",
        targetHandle: mode === "narrow" ? "in-left" : "in-bottom",
        type: "flow",
        data: {
          kind: l.kind,
          label: `${n.lag ? `${formatCount(n.lag.commits)} ${n.lag.commits === 1 ? "commit" : "commits"} · ${formatCount(n.lag.ms)} ms` : "streaming"}${
            n.state === "lagging" ? " · lagging" : n.state === "down" ? " · down" : ""
          }`,
          lane: l.lane,
          lanes,
          ...look,
        },
      };
    }
    return {
      id: l.id,
      source: l.source,
      target: l.target,
      sourceHandle: "out-bottom",
      type: "flow",
      data: {
        kind: l.kind,
        label: `${formatCount(cps)} commits/s`,
        tone: "normal",
        width: 1.25 + Math.min(2.5, cps / 90),
        particles: Math.max(1, Math.min(4, Math.round(cps / 60))),
        trip: Math.max(1.2, 3.5 - cps / 120),
        lock: t.store.leaseHolder !== null,
      },
    };
  });
  return { nodes, edges, links, width };
}

const PAD = 16;

function Canvas(props: {
  t: Topology;
  opened?: string;
  highlight?: string;
  onOpen: (node: string) => void;
  groups?: ClientGroup[];
  openedGroup?: string;
  onOpenGroup?: (key: string) => void;
}) {
  const { t } = props;
  const flow = useReactFlow();
  const dark = useDark();
  const reduced = useReducedMotion();
  const box = useRef<HTMLElement>(null);
  // the layout is chosen once, by the canvas's width when it opens: a resize never rearranges it
  const [mode] = useState<LayoutMode>(() =>
    typeof matchMedia === "function" && matchMedia("(max-width: 639px)").matches ? "narrow" : "wide",
  );
  const [hovered, setHovered] = useState<string>();
  const [labels, setLabels] = useState(true);
  const { nodes, edges, links, width } = useMemo(
    () => toFlow(t, props.opened, mode, props.groups, props.openedGroup),
    [t, props.opened, mode, props.groups, props.openedGroup],
  );
  // hovered: a card's id; highlight: a node picked in the feed
  const focus = hovered ?? (props.highlight ? serverId(props.highlight) : undefined);
  const lit = useMemo(() => (focus ? neighbourhood(focus, links) : null), [focus, links]);
  const shape = [...t.nodes.map((n) => `${n.id}:${n.role}`), ...(props.groups ?? []).map((g) => g.key)].join(",");
  const duration = reduced ? 0 : 200;
  const frame = () => {
    // never past 100 % (the owner found bigger cards too big, 1 Oct 2026); the cards' own text is 12 px (UX2-14)
    if (mode === "wide") return void flow.fitView({ padding: 0.1, maxZoom: 1, duration });
    // a phone: the column fills the width at a readable zoom, its top in view; the reader pans down
    const w = box.current?.clientWidth ?? 360;
    void flow.setViewport({ x: PAD / 2, y: PAD, zoom: Math.min(1.15, (w - PAD) / width) }, { duration });
  };
  // a new node set (one joined or left) is a new frame; vitals alone never move or re-frame anything
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-frame on the node set only
  useEffect(() => {
    const id = setTimeout(frame, 0);
    return () => clearTimeout(id);
  }, [shape]);
  const look = useMemo(() => ({ lit, labels, reduced, mode }), [lit, labels, reduced, mode]);
  const node = (id: string) =>
    id.startsWith("node:") ? id.slice(5) : id.startsWith("clients:") ? id.slice(8) : undefined;
  const hoverId = (id: string) => (id.startsWith("clients:") ? serverId(id.slice(8)) : id);
  return (
    <LookContext.Provider value={look}>
      <section
        ref={box}
        aria-label="Topology diagram"
        className="relative min-h-0 flex-1"
        data-layout={mode}
        data-reduced-motion={reduced ? "" : undefined}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          const card = (e.target as HTMLElement).closest(".react-flow__node-server, .react-flow__node-clientgroup");
          const id = card?.getAttribute("data-id");
          if (!id) return;
          e.preventDefault();
          if (id.startsWith("group:")) props.onOpenGroup?.(id.slice(6));
          else props.onOpen(id.slice(5));
        }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={(_, n) => {
            if (n.id.startsWith("group:")) return props.onOpenGroup?.(n.id.slice(6));
            const id = node(n.id);
            if (id) props.onOpen(id);
          }}
          onNodeMouseEnter={(_, n) => setHovered(n.id === STORE_ID ? undefined : hoverId(n.id))}
          onNodeMouseLeave={() => setHovered(undefined)}
          colorMode={dark ? "dark" : "light"}
          fitView={mode === "wide"}
          fitViewOptions={{ padding: 0.1, maxZoom: 1 }}
          minZoom={0.2}
          maxZoom={1.75}
          // a phone pans with a finger or a scroll, vertically first
          panOnScroll={mode === "narrow"}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          edgesFocusable={false}
          nodesFocusable
          proOptions={{ hideAttribution: true }}
          className="[--xy-background-color:var(--color-background)] [--xy-node-border-radius:0]"
        >
          <FlowBackground />
          <FlowControls
            onZoomIn={() => void flow.zoomIn({ duration })}
            onZoomOut={() => void flow.zoomOut({ duration })}
            onFit={frame}
          >
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Show labels"
              aria-pressed={labels}
              onClick={() => setLabels((v) => !v)}
            >
              <Tags aria-hidden="true" />
            </Button>
          </FlowControls>
        </ReactFlow>
      </section>
    </LookContext.Provider>
  );
}

export function TopologyDiagram(props: {
  topology: Topology;
  opened?: string;
  /** A node to light up (an event picked in the feed). */
  highlight?: string;
  onOpen: (node: string) => void;
  /** Who the clients are, grouped (UI-01 §33): one card per group instead of one per serving node. */
  groups?: ClientGroup[];
  openedGroup?: string;
  onOpenGroup?: (key: string) => void;
}) {
  return (
    <ReactFlowProvider>
      <Canvas
        t={props.topology}
        opened={props.opened}
        highlight={props.highlight}
        onOpen={props.onOpen}
        groups={props.groups}
        openedGroup={props.openedGroup}
        onOpenGroup={props.onOpenGroup}
      />
    </ReactFlowProvider>
  );
}
