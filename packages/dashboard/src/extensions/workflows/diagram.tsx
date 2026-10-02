// A run's steps as a diagram (UI-01 §26.3): React Flow, top to bottom — one row per group of steps that run
// together, the steps of a group side by side (a `Promise.all`), an edge from every step of a group to every
// step of the next. Each node: the kind, the function, its status as an icon and a word, its tries and how long
// it took; the running one pulses (not under reduced motion). Fixed layout, not draggable; a click or Enter on
// a node selects the step (its journal entry opens below).
import "@xyflow/react/dist/style.css";
import { cn } from "@bunvex/ui/lib/utils";
import { type Edge, Handle, type Node, type NodeProps, Position, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { useMemo } from "react";
import { FlowBackground } from "../../shell/flow-controls.tsx";
import type { WorkflowStep } from "./data-source.ts";
import { duration, elapsed, KIND, STATUS } from "./words.ts";

const W = 220;
const H = 72;
const GAP_X = 32;
const GAP_Y = 56;

type StepData = { step: WorkflowStep; now: number; selected: boolean };

/** Positions by group (row) and place in the group (column), centred on x = 0. */
export function layoutSteps(journal: WorkflowStep[]): { step: WorkflowStep; x: number; y: number }[] {
  const groups = [...new Set(journal.map((s) => s.group))];
  return journal.map((step) => {
    const row = groups.indexOf(step.group);
    const peers = journal.filter((s) => s.group === step.group);
    const col = peers.indexOf(step);
    const width = peers.length * W + (peers.length - 1) * GAP_X;
    return { step, x: -width / 2 + col * (W + GAP_X), y: row * (H + GAP_Y) };
  });
}

function StepNode({ data }: NodeProps<Node<StepData>>) {
  const { step, now, selected } = data;
  const s = STATUS[step.status];
  const took = elapsed(step.startedAt, step.finishedAt, now);
  const live = step.status === "running" || step.status === "retrying";
  return (
    <div
      className={cn(
        "flex h-[72px] w-[220px] flex-col justify-center gap-0.5 border bg-background px-3 text-xs shadow-sm",
        selected && "ring-2 ring-ring",
        live && "border-info motion-safe:animate-pulse",
        step.status === "failed" && "border-destructive",
      )}
    >
      <Handle type="target" position={Position.Top} className="!invisible" />
      <span className="text-[11px] text-muted-foreground">
        {step.index + 1}. {KIND[step.kind]}
      </span>
      <span className="truncate font-mono text-[13px]">{step.name}</span>
      <span className={cn("flex items-center gap-1", s.tone)}>
        <s.icon
          aria-hidden="true"
          className={cn("size-3.5", step.status === "running" && "motion-safe:animate-spin")}
        />
        {s.word}
        <span className="text-muted-foreground">
          {step.attempts > 1 ? ` · ${step.attempts} tries` : ""}
          {took !== null ? ` · ${duration(took)}` : ""}
        </span>
      </span>
      <Handle type="source" position={Position.Bottom} className="!invisible" />
    </div>
  );
}

const nodeTypes = { step: StepNode };

export function stepLabel(step: WorkflowStep, now: number): string {
  const took = elapsed(step.startedAt, step.finishedAt, now);
  return `Step ${step.index + 1}, ${KIND[step.kind]} ${step.name}: ${STATUS[step.status].word}${
    step.attempts > 1 ? `, ${step.attempts} tries` : ""
  }${took !== null ? `, ${duration(took)}` : ""}`;
}

export default function RunDiagram(props: {
  journal: WorkflowStep[];
  now: number;
  selected: number | undefined;
  onSelect: (index: number) => void;
}) {
  const { nodes, edges } = useMemo(() => {
    const placed = layoutSteps(props.journal);
    const nodes: Node<StepData>[] = placed.map(({ step, x, y }) => ({
      id: String(step.index),
      type: "step",
      position: { x, y },
      data: { step, now: props.now, selected: props.selected === step.index },
      ariaLabel: stepLabel(step, props.now),
      draggable: false,
      connectable: false,
    }));
    const groups = [...new Set(props.journal.map((s) => s.group))];
    const edges: Edge[] = [];
    groups.forEach((g, i) => {
      const next = groups[i + 1];
      if (next === undefined) return;
      for (const a of props.journal.filter((s) => s.group === g))
        for (const b of props.journal.filter((s) => s.group === next))
          edges.push({
            id: `${a.index}-${b.index}`,
            source: String(a.index),
            target: String(b.index),
            style: { stroke: "var(--border)", strokeWidth: 1.5 },
            animated: b.status === "running" || b.status === "retrying",
          });
    });
    return { nodes, edges };
  }, [props.journal, props.now, props.selected]);
  return (
    <ReactFlowProvider>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.5}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onNodeClick={(_, n) => props.onSelect(Number(n.id))}
        onNodesChange={() => {}}
        proOptions={{ hideAttribution: true }}
        ariaLabelConfig={{ "node.a11yDescription.default": "Press Enter to open the step's journal entry." }}
        onKeyDown={(e) => {
          const id = (e.target as HTMLElement).closest(".react-flow__node")?.getAttribute("data-id");
          if (e.key === "Enter" && id) props.onSelect(Number(id));
        }}
      >
        <FlowBackground />
      </ReactFlow>
    </ReactFlowProvider>
  );
}
