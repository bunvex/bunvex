// Pieces the Topology screen and its node panel share (UI-01 §22): a node's state said with an icon and a
// word (never the colour alone), and its lag as a bar against a fixed scale, so followers compare at a glance.
import { cn } from "@bunvex/ui/lib/utils";
import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";
import type { NodeState } from "../data-source.ts";
import { STATE } from "./words.ts";

/** The lag bar's full width, in ms. */
const LAG_SCALE_MS = 1000;

const STATE_LOOK: Record<NodeState, { icon: typeof CircleCheck; tone: string }> = {
  ok: { icon: CircleCheck, tone: "text-success" },
  lagging: { icon: TriangleAlert, tone: "text-warning" },
  down: { icon: CircleX, tone: "text-destructive" },
};

export function StateLabel({ state }: { state: NodeState }) {
  const { icon: Icon, tone } = STATE_LOOK[state];
  return (
    <span className="inline-flex items-center gap-1 text-xs" data-state={state}>
      <Icon aria-hidden="true" className={cn("size-3.5", tone)} />
      {STATE[state]}
    </span>
  );
}

/** How far behind, as a bar against a fixed scale: the eye compares followers at a glance. */
export function LagGauge({ ms, state }: { ms: number; state: NodeState }) {
  const fill = Math.min(1, ms / LAG_SCALE_MS);
  return (
    <span aria-hidden="true" className="block h-1 w-full bg-muted">
      <span
        className={cn(
          "block h-full",
          state === "ok" ? "bg-info" : state === "lagging" ? "bg-warning" : "bg-destructive",
        )}
        style={{ width: `${Math.max(2, fill * 100)}%` }}
      />
    </span>
  );
}
