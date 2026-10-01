// The Topology screen's diagram (UI-01 §22): a canvas in fixed layers (layout.ts) — the clients of each
// serving node, the followers, the leader, the store — with icons and rich node cards, and edges that say
// what flows: WebSockets, the commit stream (its lag in words and colour, its width by commits per second,
// particles moving along it unless the reader prefers reduced motion) and the leader's commits to the store,
// where it holds the lease. Hovering a node (or picking one of the feed's events) lights its edges and dims
// the rest; a click or Enter opens its details. Drawn with React Flow, as the Schema screen is.
import "@xyflow/react/dist/style.css";
import { Button } from "@bunvex/ui/components/button";
import { cn } from "@bunvex/ui/lib/utils";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import { Crown, Database, Expand, Lock, MemoryStick, Minus, MonitorSmartphone, Plus, Server, Tags } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Topology, TopologyNode, TopologyStore } from "../data-source.ts";
import { formatBytes, formatCount, formatPercent } from "../screens/stats.ts";
import { type Link, layoutTopology, neighbourhood, STORE_ID } from "./layout.ts";
import { LagGauge, StateLabel } from "./parts.tsx";
import { DRIVER, lagText, servesClients } from "./words.ts";

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
type Look = { lit: Set<string> | null; labels: boolean; reduced: boolean };
const LookContext = createContext<Look>({ lit: null, labels: true, reduced: false });
const dimmed = (look: Look, id: string) => look.lit !== null && !look.lit.has(id);

// ------------------------------------------------------------------ nodes

type ClientsData = { node: string; connections: number; subscriptions: number };
type ServerData = { node: TopologyNode; topology: Topology; opened: boolean };
type StoreData = { store: TopologyStore };

const CARD = "w-[248px] border bg-card text-card-foreground shadow-xs transition-opacity";
const HANDLE = "!size-1.5 !min-h-0 !min-w-0 !border-0 !bg-border";

function Meter({ label, value, text }: { label: string; value: number | null; text: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-12 text-muted-foreground">{label}</span>
      <span aria-hidden="true" className="h-1 flex-1 bg-muted">
        <span
          className={cn("block h-full", (value ?? 0) > 0.85 ? "bg-warning" : "bg-muted-foreground/60")}
          style={{ width: `${Math.round(Math.min(1, Math.max(0, value ?? 0)) * 100)}%` }}
        />
      </span>
      <span className="w-14 text-right font-mono tabular-nums">{text}</span>
    </div>
  );
}

function ClientsNode({ id, data }: NodeProps<Node<ClientsData, "clients">>) {
  const look = useContext(LookContext);
  return (
    <div className={cn(CARD, "flex items-center gap-3 border-dashed px-3 py-2", dimmed(look, id) && "opacity-30")}>
      <MonitorSmartphone aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="font-mono text-xl leading-tight tabular-nums">{formatCount(data.connections)}</p>
        <p className="text-[11px] text-muted-foreground">clients · {formatCount(data.subscriptions)} subscriptions</p>
      </div>
      <Handle type="source" position={Position.Bottom} className={HANDLE} isConnectable={false} />
    </div>
  );
}

function ServerNode({ id, data }: NodeProps<Node<ServerData, "server">>) {
  const look = useContext(LookContext);
  const { node: n, topology: t } = data;
  const leader = n.role === "leader";
  const followers = t.nodes.length - 1;
  return (
    <div
      className={cn(
        CARD,
        "flex flex-col gap-2 p-3",
        leader && "border-foreground/40",
        data.opened && "ring-2 ring-ring",
        n.state === "down" && "opacity-70",
        dimmed(look, id) && "opacity-30",
      )}
    >
      <Handle id="in-top" type="target" position={Position.Top} className={HANDLE} isConnectable={false} />
      <Handle id="out-top" type="source" position={Position.Top} className={HANDLE} isConnectable={false} />
      <div className="flex items-center gap-2">
        <Server aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium">{n.id}</span>
        {leader && (
          <span className="inline-flex items-center gap-1 border px-1.5 py-0.5 text-[11px]">
            <Crown aria-hidden="true" className="size-3 text-warning" />
            {followers > 0 ? "Leader" : "Node"}
          </span>
        )}
        <StateLabel state={n.state} />
      </div>
      {n.lag && (
        <div className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          <span>{lagText(n.lag)}</span>
          <LagGauge ms={n.lag.ms} state={n.state} />
        </div>
      )}
      {leader && (
        <p className="text-[11px] text-muted-foreground">
          {n.commitsPerSecond !== undefined && `${formatCount(n.commitsPerSecond)} commits/s`}
          {n.scheduler && " · runs the scheduler"}
        </p>
      )}
      <div className="flex flex-col gap-1">
        <Meter label="CPU" value={n.cpu} text={n.cpu === null ? "—" : formatPercent(n.cpu)} />
        <Meter
          label="Memory"
          value={n.memoryBytes !== null && n.memoryLimitBytes ? n.memoryBytes / n.memoryLimitBytes : null}
          text={n.memoryBytes === null ? "—" : formatBytes(n.memoryBytes)}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        {servesClients(n, t) ? `${formatCount(n.subscriptions)} subscriptions · ` : ""}
        {n.cacheHitRate === null ? "" : `${formatPercent(n.cacheHitRate)} cache hits · `}
        {formatCount(n.actionsRunning)} actions
      </p>
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
    <div className={cn(CARD, "flex flex-col gap-1.5 p-3", dimmed(look, id) && "opacity-30")}>
      <Handle type="target" position={Position.Top} className={HANDLE} isConnectable={false} />
      <div className="flex items-center gap-2">
        <Icon aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-sm font-medium">{DRIVER[s.driver]}</span>
        <span className="text-[11px] text-muted-foreground">store</span>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {s.singleNode
          ? "One node: a file lock keeps a second one out"
          : s.leaseHolder
            ? `Lease held by ${s.leaseHolder}${s.leaseTtlMs !== null ? ` · TTL ${Math.round(s.leaseTtlMs / 1000)} s` : ""}`
            : "No node holds the lease"}
      </p>
      <p className="font-mono text-[11px] tabular-nums">
        {[
          s.latencyMs !== null && `${formatCount(s.latencyMs)} ms`,
          s.sizeBytes !== null && formatBytes(s.sizeBytes),
          s.connections &&
            `${formatCount(s.connections.used)}${s.connections.max ? `/${formatCount(s.connections.max)}` : ""} conns`,
        ]
          .filter(Boolean)
          .join(" · ") || "in memory"}
      </p>
    </div>
  );
}

const nodeTypes = { clients: ClientsNode, server: ServerNode, store: StoreNode };

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
};

const TONE = {
  normal: "var(--color-info)",
  warning: "var(--color-warning)",
  critical: "var(--color-destructive)",
} as const;

function FlowEdge(props: EdgeProps<Edge<FlowData, "flow">>) {
  const look = useContext(LookContext);
  const d = props.data!;
  const [path, midX, midY] = getBezierPath(props);
  // the commit streams all leave the leader's head: their labels sit near each follower instead, by column
  const near = d.kind === "stream" ? 0.72 : 0.5;
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
          strokeDasharray: d.kind === "clients" ? "4 4" : undefined,
          opacity: faded ? 0.15 : 0.9,
        }}
      />
      {!look.reduced &&
        !faded &&
        Array.from({ length: d.particles }, (_, i) => `${props.id}:${i}`).map((key, i) => (
          <circle key={key} r={Math.max(2, d.width * 0.9)} fill={colour} data-particle="">
            <animateMotion
              dur={`${d.trip}s`}
              // a negative start: every particle is already on its way, none waits at the origin
              begin={`-${(i * d.trip) / d.particles}s`}
              repeatCount="indefinite"
              path={path}
            />
          </circle>
        ))}
      {look.labels && (
        <EdgeLabelRenderer>
          <div
            className={cn(
              "nodrag nopan pointer-events-none absolute inline-flex items-center gap-1 border bg-background px-1.5 py-0.5 font-mono text-[11px] tabular-nums transition-opacity",
              d.tone === "warning" && "border-warning text-foreground",
              d.tone === "critical" && "border-destructive text-destructive",
              faded && "opacity-20",
            )}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            data-edge-label={props.id}
          >
            {d.lock && <Lock aria-hidden="true" className="size-3" />}
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
    width: 1.5 + Math.min(3, cps / 80),
    particles: follower.state === "down" ? 0 : Math.max(1, Math.min(5, Math.round(cps / 50))),
    trip: Math.max(1.2, 4 - cps / 100),
  };
}

// ------------------------------------------------------------------ the canvas

/** The picture as React Flow nodes and edges (exported for tests: happy-dom cannot measure, so draws no edge). */
export function toFlow(t: Topology, opened: string | undefined) {
  const { placed, links } = layoutTopology(t);
  const byId = new Map(t.nodes.map((n) => [n.id, n]));
  const leader = t.nodes.find((n) => n.role === "leader");
  const cps = leader?.commitsPerSecond ?? 0;
  const nodes: Node[] = placed.map((p) => {
    if (p.kind === "clients") {
      const n = byId.get(p.node)!;
      return {
        id: p.id,
        type: "clients",
        position: { x: p.x, y: p.y },
        focusable: false,
        data: { node: n.id, connections: n.connections, subscriptions: n.subscriptions },
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
    if (l.kind === "clients")
      return {
        id: l.id,
        source: l.source,
        target: l.target,
        type: "flow",
        data: {
          kind: l.kind,
          label: `${formatCount(n.connections)} ws`,
          tone: "normal",
          width: 1.25,
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
        // up from the leader into the follower's foot
        sourceHandle: "out-top",
        targetHandle: "in-bottom",
        type: "flow",
        data: {
          kind: l.kind,
          label: `${n.lag ? `${formatCount(n.lag.commits)} commits · ${formatCount(n.lag.ms)} ms` : "streaming"}${
            n.state === "lagging" ? " · lagging" : n.state === "down" ? " · down" : ""
          }`,
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
        width: 1.5 + Math.min(3, cps / 80),
        particles: Math.max(1, Math.min(4, Math.round(cps / 60))),
        trip: Math.max(1.2, 3.5 - cps / 120),
        lock: t.store.leaseHolder !== null,
      },
    };
  });
  return { nodes, edges, links };
}

function Canvas(props: { t: Topology; opened?: string; highlight?: string; onOpen: (node: string) => void }) {
  const { t } = props;
  const flow = useReactFlow();
  const dark = useDark();
  const reduced = useReducedMotion();
  const [hovered, setHovered] = useState<string>();
  const [labels, setLabels] = useState(true);
  const { nodes, edges, links } = useMemo(() => toFlow(t, props.opened), [t, props.opened]);
  const focus = hovered ?? props.highlight;
  const lit = useMemo(() => (focus ? neighbourhood(focus, links) : null), [focus, links]);
  const shape = t.nodes.map((n) => `${n.id}:${n.role}`).join(",");
  const duration = reduced ? 0 : 200;
  // a new node set (one joined or left) is a new frame; vitals alone never move or re-frame anything
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-frame on the node set only
  useEffect(() => {
    const id = setTimeout(() => void flow.fitView({ padding: 0.12, duration }), 0);
    return () => clearTimeout(id);
  }, [shape]);
  const look = useMemo(() => ({ lit, labels, reduced }), [lit, labels, reduced]);
  const node = (id: string) =>
    id.startsWith("node:") ? id.slice(5) : id.startsWith("clients:") ? id.slice(8) : undefined;
  return (
    <LookContext.Provider value={look}>
      <section
        aria-label="Topology diagram"
        className="relative h-[clamp(24rem,60svh,42rem)] border"
        data-reduced-motion={reduced ? "" : undefined}
        onKeyDown={(e) => {
          const id = (e.target as HTMLElement).closest(".react-flow__node-server")?.getAttribute("data-id");
          if (id && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            props.onOpen(id.slice(5));
          }
        }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={(_, n) => {
            const id = node(n.id);
            if (id) props.onOpen(id);
          }}
          onNodeMouseEnter={(_, n) => setHovered(node(n.id))}
          onNodeMouseLeave={() => setHovered(undefined)}
          colorMode={dark ? "dark" : "light"}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          minZoom={0.2}
          maxZoom={1.75}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          edgesFocusable={false}
          nodesFocusable
          proOptions={{ hideAttribution: true }}
          className="[--xy-background-color:var(--color-background)] [--xy-minimap-background-color:var(--color-card)] [--xy-node-border-radius:0]"
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="var(--color-border)" />
          <div className="absolute bottom-3 left-3 z-10 flex items-center gap-1 border bg-background p-1 shadow-sm">
            <Button variant="ghost" size="icon-sm" aria-label="Zoom in" onClick={() => void flow.zoomIn({ duration })}>
              <Plus aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom out"
              onClick={() => void flow.zoomOut({ duration })}
            >
              <Minus aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Fit to view"
              onClick={() => void flow.fitView({ padding: 0.12, duration })}
            >
              <Expand aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Show labels"
              aria-pressed={labels}
              onClick={() => setLabels((v) => !v)}
            >
              <Tags aria-hidden="true" />
            </Button>
          </div>
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
}) {
  return (
    <ReactFlowProvider>
      <Canvas t={props.topology} opened={props.opened} highlight={props.highlight} onOpen={props.onOpen} />
    </ReactFlowProvider>
  );
}
