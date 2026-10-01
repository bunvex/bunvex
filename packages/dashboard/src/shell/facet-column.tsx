// A screen's filter column (UI-01 §22.4, §22.5): to the left of its grid, as the tables list is on the Database
// screen — fixed, resizable from its right edge, its width kept in this browser — with a 44 px header on the
// first bar's line, then sections: groups of checkboxes or radios, each choice with how many loaded rows it
// holds, in text. Below `md` it is hidden: the screen offers the same sections in a sheet (`FiltersSheet`).
import { Button } from "@bunvex/ui/components/button";
import { Checkbox } from "@bunvex/ui/components/checkbox";
import { ResizeHandle } from "@bunvex/ui/components/resize-handle";
import { cn } from "@bunvex/ui/lib/utils";
import { ListFilter } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { formatCount } from "../screens/stats.ts";
import { Panel } from "./panel.tsx";

const DEFAULT = 224;
const MIN = 176;
const MAX = 440;

/** The column's width, kept in this browser under `key`; `undefined` puts the default back. */
function useWidth(key: string): [number, (w: number | undefined) => void] {
  const [width, setState] = useState(() => {
    try {
      const w = Number(localStorage.getItem(key));
      return w >= MIN && w <= MAX ? w : DEFAULT;
    } catch {
      return DEFAULT;
    }
  });
  const set = (w: number | undefined) => {
    setState(w ?? DEFAULT);
    try {
      if (w === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, String(w));
    } catch {
      // for this page only
    }
  };
  return [width, set];
}

/** The column beside the grid, from `md`. */
export function FacetColumn(props: {
  /** The navigation landmark's name, e.g. "Log filters". */
  label: string;
  widthKey: string;
  /** Shown when some filter applies. */
  onReset?: () => void;
  children: ReactNode;
}) {
  const [width, setWidth] = useWidth(props.widthKey);
  const [dragging, setDragging] = useState<number>();
  return (
    <nav
      aria-label={props.label}
      className="relative hidden shrink-0 flex-col border-r md:flex"
      style={{ width: dragging ?? width }}
    >
      <div className="flex min-h-11 items-center justify-between gap-2 border-b px-3">
        <h2 className="text-sm font-medium">Filters</h2>
        {props.onReset && (
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={props.onReset}
          >
            Reset
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{props.children}</div>
      <ResizeHandle
        label="Resize the filters"
        value={dragging ?? width}
        min={MIN}
        max={MAX}
        onDrag={setDragging}
        onCommit={(w) => {
          setDragging(undefined);
          setWidth(w);
        }}
      />
    </nav>
  );
}

/** Below `md`: a Filters button for the first bar, and the sheet it opens with the same sections. */
export function useFiltersSheet(props: { kind: string; onReset?: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const button = (
    <Button variant="outline" size="sm" className="md:hidden" aria-pressed={open} onClick={() => setOpen(!open)}>
      <ListFilter aria-hidden="true" />
      Filters
    </Button>
  );
  const sheet = open && (
    <Panel kind={props.kind} title="Filters" onClose={() => setOpen(false)}>
      <div className="-mx-4 -mt-4">{props.children}</div>
      {props.onReset && (
        <Button variant="outline" size="sm" className="mt-4" onClick={props.onReset}>
          Reset filters
        </Button>
      )}
    </Panel>
  );
  return { button, sheet };
}

/** A section's frame: a heading, and "All" when the section narrows the list. */
export function FacetSection(props: { title: string; onAll?: () => void; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="border-b py-2">
      <div className="flex items-center justify-between px-3 pb-1">
        <h3 id={id} className="text-xs font-medium text-muted-foreground">
          {props.title}
        </h3>
        {props.onAll && (
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={props.onAll}
          >
            All
          </button>
        )}
      </div>
      {props.children}
    </section>
  );
}

const Count = ({ n }: { n?: number }) =>
  n === undefined ? null : (
    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatCount(n)}</span>
  );

/** One checkbox: its name, and how many loaded rows it holds. */
function Choice(props: {
  label: ReactNode;
  checked: boolean;
  count?: number;
  onChange: (on: boolean) => void;
  mono?: boolean;
}) {
  const id = useId();
  return (
    <li className="flex items-center gap-2 px-3 py-1 hover:bg-muted/50">
      <Checkbox id={id} checked={props.checked} onCheckedChange={(on) => props.onChange(on === true)} />
      <label htmlFor={id} className={cn("min-w-0 flex-1 cursor-pointer truncate", props.mono && "font-mono text-xs")}>
        {props.label}
      </label>
      <Count n={props.count} />
    </li>
  );
}

/** Checkboxes over `options`; "all" when every one is checked (it also takes in later ones). */
export function FacetGroup<T extends string>(props: {
  title: string;
  options: readonly T[];
  value: T[] | "all";
  counts: Map<T, number>;
  onChange: (v: T[] | "all") => void;
  /** A choice's words; the value itself by default. */
  label?: (o: T) => ReactNode;
  mono?: boolean;
}) {
  const chosen = props.value === "all" ? props.options : props.value;
  const set = (o: T, on: boolean) => {
    const next = on ? [...chosen, o] : chosen.filter((x) => x !== o);
    props.onChange(props.options.every((x) => next.includes(x)) ? "all" : next);
  };
  return (
    <FacetSection title={props.title} onAll={props.value !== "all" ? () => props.onChange("all") : undefined}>
      <ul className="text-sm">
        {props.options.map((o) => (
          <Choice
            key={o}
            label={props.label?.(o) ?? o}
            mono={props.mono}
            checked={chosen.includes(o)}
            count={props.counts.get(o) ?? 0}
            onChange={(on) => set(o, on)}
          />
        ))}
      </ul>
    </FacetSection>
  );
}

/** One choice of several (radios), each with an optional count. */
export function FacetRadios<T extends string>(props: {
  title: string;
  options: readonly { value: T; label: ReactNode; count?: number; mono?: boolean }[];
  value: T | undefined;
  onChange: (v: T) => void;
  /** Under the choices, e.g. what a custom value means. */
  note?: ReactNode;
}) {
  const id = useId();
  const name = useId();
  return (
    <section aria-labelledby={id} className="border-b py-2">
      <h3 id={id} className="px-3 pb-1 text-xs font-medium text-muted-foreground">
        {props.title}
      </h3>
      <div role="radiogroup" aria-labelledby={id}>
        {props.options.map((o) => {
          const rid = `${name}-${o.value}`;
          return (
            <div key={o.value} className="flex items-center gap-2 px-3 py-1 text-sm hover:bg-muted/50">
              <input
                id={rid}
                type="radio"
                name={name}
                className="size-3.5 shrink-0 accent-primary"
                checked={props.value === o.value}
                onChange={() => props.onChange(o.value)}
              />
              <label
                htmlFor={rid}
                className={cn("min-w-0 flex-1 cursor-pointer truncate", o.mono && "font-mono text-xs")}
              >
                {o.label}
              </label>
              <Count n={o.count} />
            </div>
          );
        })}
      </div>
      {props.note && <p className="px-3 pt-1 text-xs text-muted-foreground">{props.note}</p>}
    </section>
  );
}
