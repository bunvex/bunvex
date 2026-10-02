// The controls of a canvas screen (Schema, Topology — UI-01 §21, §22): docked bottom-left over the canvas, zoom
// in, zoom out and fit, then whatever the screen adds. Both canvases share them, so they look and behave alike.
import { Button } from "@bunvex/ui/components/button";
import { Background } from "@xyflow/react";
import { Expand, Minus, Plus } from "lucide-react";
import type { ReactNode } from "react";

export function FlowControls(props: {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="absolute bottom-3 left-3 z-10 flex flex-wrap items-center gap-1 border bg-background p-1 shadow-sm">
      <Button variant="ghost" size="icon-sm" aria-label="Zoom in" onClick={props.onZoomIn}>
        <Plus aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Zoom out" onClick={props.onZoomOut}>
        <Minus aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Fit to view" onClick={props.onFit}>
        <Expand aria-hidden="true" />
      </Button>
      {props.children}
    </div>
  );
}

/** The canvases' shared backdrop: a quiet dot grid in the border colour. */
export function FlowBackground() {
  return <Background gap={24} size={1} color="var(--color-border)" />;
}

/**
 * How a canvas fits its graph (UX2-14): never past 100 % for a big one, but a small graph (up to six nodes) is
 * shown at least at 85 % and up to 125 %, centred, so its text stays readable instead of a corner of tiny cards.
 */
export function fitOptions(nodeCount: number, padding: number) {
  return nodeCount <= 6 ? { padding, minZoom: 0.85, maxZoom: 1.25 } : { padding, maxZoom: 1 };
}
