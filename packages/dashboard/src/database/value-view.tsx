// A cell's whole value, next to the cell (STUDY-12 D11: the menu's "View <field>", or Space), as Convex's
// data browser shows a cell's detail: the field's name, the value as a literal, Copy. Escape or a click
// elsewhere closes it; the grid takes the focus back.
import { CopyButton } from "@bunvex/ui/components/copy-button";
import { Popover, PopoverContent } from "@bunvex/ui/components/popover";
import type { Value } from "../data-source.ts";
import { clipboardText } from "./cell-menu.tsx";
import { formatLiteral } from "./literal.ts";

export type Viewing = { field: string; value: Value | undefined; anchor: DOMRect };

export function ValueView({ viewing, onClose }: { viewing: Viewing; onClose: () => void }) {
  const { field, value, anchor } = viewing;
  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverContent
        anchor={{ getBoundingClientRect: () => anchor }}
        side="bottom"
        align="start"
        sideOffset={0}
        // the grid puts the focus back on the cell
        finalFocus={false}
        aria-label={`Value of ${field}`}
        className="w-[28rem] max-w-[80vw]"
      >
        <div className="flex items-center justify-between gap-2">
          {/* a plain heading: a Popover title would name the popup by the field alone */}
          <h2 className="font-mono text-sm font-medium">{field}</h2>
          <CopyButton text={clipboardText(value)} label={`Copy ${field}`} />
        </div>
        {value === undefined ? (
          <p className="text-muted-foreground">This document has no {field} field.</p>
        ) : (
          <pre
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a region that scrolls must be reachable by keyboard
            tabIndex={0}
            className="max-h-80 overflow-auto border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap break-all"
          >
            {formatLiteral(value, "  ")}
          </pre>
        )}
      </PopoverContent>
    </Popover>
  );
}
