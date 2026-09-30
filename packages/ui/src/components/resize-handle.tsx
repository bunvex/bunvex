// A draggable edge that sets a width (UI-01 §12.5.6): the right edge of a column header, of the table list.
// It is a focusable separator carrying its value (the WAI-ARIA "window splitter" pattern): drag it, or
// focus it and use Left/Right (16 px, Shift for 64); Enter or a double-click puts the default back.
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
  className?: string;
};

function ResizeHandle({ label, value, min, max, onDrag, onCommit, className }: ResizeHandleProps) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const clamp = (w: number) => Math.round(Math.min(max, Math.max(min, w)));
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
        "absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none outline-none hover:bg-ring/40 focus-visible:bg-ring",
        className,
      )}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        start.current = { x: e.clientX, width: value };
      }}
      onPointerMove={(e) => {
        if (start.current) onDrag(clamp(start.current.width + e.clientX - start.current.x));
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        const width = clamp(start.current.width + e.clientX - start.current.x);
        start.current = null;
        onCommit(width);
      }}
      onDoubleClick={() => onCommit(undefined)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          onCommit(clamp(value + (e.key === "ArrowRight" ? step : -step)));
        } else if (e.key === "Enter") {
          e.preventDefault();
          onCommit(undefined);
        }
      }}
    />
  );
}

export { ResizeHandle };
