// A draggable edge that sets a width (UI-01 §12.5.6): the right edge of a column header, of the table list;
// the left edge of a side panel docked on the right (UI-01 §22.1). It is a focusable separator carrying its
// value (the WAI-ARIA "window splitter" pattern): drag it, or focus it and use Left/Right (16 px, Shift for
// 64) — the arrow that moves the edge outwards widens; Enter or a double-click puts the default back.
// The caller keeps the width: `onDrag` while dragging (show it, do not save it), `onCommit` when done
// (`undefined` = back to the default).
import { cn } from "@bunvex/ui/lib/utils";
import { useRef } from "react";

type ResizeHandleProps = {
  /** The accessible name, e.g. "Resize name". */
  label: string;
  value: number;
  min: number;
  max: number;
  onDrag: (width: number) => void;
  onCommit: (width: number | undefined) => void;
  /** Which edge of the sized element it is. Default `right` (dragging right widens); `left` widens leftwards. */
  edge?: "left" | "right";
  className?: string;
};

function ResizeHandle({ label, value, min, max, onDrag, onCommit, edge = "right", className }: ResizeHandleProps) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const clamp = (w: number) => Math.round(Math.min(max, Math.max(min, w)));
  const sign = edge === "right" ? 1 : -1;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable splitter has no HTML element; role="separator" with a value is the APG pattern
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-slot="resize-handle"
      className={cn(
        "absolute inset-y-0 z-10 w-2 cursor-col-resize touch-none outline-none hover:bg-ring/40 focus-visible:bg-ring",
        edge === "right" ? "-right-1" : "-left-1",
        className,
      )}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        start.current = { x: e.clientX, width: value };
      }}
      onPointerMove={(e) => {
        if (start.current) onDrag(clamp(start.current.width + sign * (e.clientX - start.current.x)));
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        const width = clamp(start.current.width + sign * (e.clientX - start.current.x));
        start.current = null;
        onCommit(width);
      }}
      onDoubleClick={() => onCommit(undefined)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          onCommit(clamp(value + (e.key === "ArrowRight" ? step : -step) * sign));
        } else if (e.key === "Enter") {
          e.preventDefault();
          onCommit(undefined);
        }
      }}
    />
  );
}

export { ResizeHandle };
