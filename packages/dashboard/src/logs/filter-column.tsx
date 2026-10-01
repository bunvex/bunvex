// The Logs filter column (UI-01 §22.4): to the left of the list, as the tables list is on the Database screen —
// fixed, resizable from its right edge, its width kept in this browser — with sections: Time range (presets),
// Functions, Type and Function kind, each a labelled group whose choices say, in text, how many loaded lines
// they hold (under the time range and the search). The Functions screen's column has Time range and Type
// only: its list is one function's. On a phone the same sections open in a sheet (FiltersButton).
import { Checkbox } from "@bunvex/ui/components/checkbox";
import { ResizeHandle } from "@bunvex/ui/components/resize-handle";
import { cn } from "@bunvex/ui/lib/utils";
import { type ReactNode, useId, useState } from "react";
import type { FunctionKind } from "../data-source.ts";
import { formatCount } from "../screens/stats.ts";
import {
  FUNCTION_KINDS,
  LOG_TYPES,
  type LogType,
  type LogView,
  RANGE_LABEL,
  RANGES,
  type RangePreset,
} from "./log-filter.ts";

const DEFAULT = 224;
const MIN = 176;
const MAX = 440;

/** The column's width, kept in this browser (one per screen: `key`). */
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

export type Counts = {
  functions: Map<string, number>;
  kinds: Map<FunctionKind, number>;
  types: Map<LogType, number>;
};

export type FilterSectionsProps = {
  view: LogView;
  onView: (v: LogView) => void;
  counts: Counts;
  /** The functions to choose from (the Logs screen); none on one function's logs. */
  functions?: string[];
  /** Whether to offer the function kinds (the Logs screen). */
  kinds?: boolean;
};

/** One choice of a group: a checkbox, its name, and how many loaded lines it holds. */
function Choice(props: {
  label: ReactNode;
  checked: boolean;
  count: number;
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
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatCount(props.count)}</span>
    </li>
  );
}

/** A group of checkboxes over `options`; "all" when every one is checked (it also takes in later ones). */
function Group<T extends string>(props: {
  title: string;
  options: readonly T[];
  value: T[] | "all";
  counts: Map<T, number>;
  onChange: (v: T[] | "all") => void;
  mono?: boolean;
}) {
  const id = useId();
  const chosen = props.value === "all" ? props.options : props.value;
  const set = (o: T, on: boolean) => {
    const next = on ? [...chosen, o] : chosen.filter((x) => x !== o);
    props.onChange(props.options.every((x) => next.includes(x)) ? "all" : next);
  };
  return (
    <section aria-labelledby={id} className="border-b py-2">
      <div className="flex items-center justify-between px-3 pb-1">
        <h3 id={id} className="text-xs font-medium text-muted-foreground">
          {props.title}
        </h3>
        {props.value !== "all" && (
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => props.onChange("all")}
          >
            All
          </button>
        )}
      </div>
      <ul aria-labelledby={id} className="text-sm">
        {props.options.map((o) => (
          <Choice
            key={o}
            label={o}
            mono={props.mono}
            checked={chosen.includes(o)}
            count={props.counts.get(o) ?? 0}
            onChange={(on) => set(o, on)}
          />
        ))}
      </ul>
    </section>
  );
}

function TimeRange({ view, onView }: Pick<FilterSectionsProps, "view" | "onView">) {
  const id = useId();
  const name = useId();
  const current = view.window ? undefined : view.range;
  return (
    <section aria-labelledby={id} className="border-b py-2">
      <h3 id={id} className="px-3 pb-1 text-xs font-medium text-muted-foreground">
        Time range
      </h3>
      <div role="radiogroup" aria-labelledby={id}>
        {(["all", ...Object.keys(RANGES)] as (RangePreset | "all")[]).map((r) => {
          const rid = `${name}-${r}`;
          return (
            <div key={r} className="flex items-center gap-2 px-3 py-1 text-sm hover:bg-muted/50">
              <input
                id={rid}
                type="radio"
                name={name}
                className="size-3.5 accent-primary"
                checked={current === r}
                onChange={() => onView({ ...view, range: r, window: undefined })}
              />
              <label htmlFor={rid} className="flex-1 cursor-pointer">
                {RANGE_LABEL[r]}
              </label>
            </div>
          );
        })}
      </div>
      {view.window && <p className="px-3 pt-1 text-xs text-muted-foreground">A window picked on the histogram.</p>}
    </section>
  );
}

/** The sections, in a column (wide screens) or a sheet (phones). */
export function FilterSections(props: FilterSectionsProps) {
  const { view, onView, counts } = props;
  return (
    <>
      <TimeRange view={view} onView={onView} />
      {props.functions && (
        <Group
          title="Functions"
          options={props.functions}
          value={view.functions}
          counts={counts.functions}
          onChange={(functions) => onView({ ...view, functions })}
          mono
        />
      )}
      <Group<LogType>
        title="Type"
        options={LOG_TYPES}
        value={view.types}
        counts={counts.types}
        onChange={(types) => onView({ ...view, types })}
      />
      {props.kinds && (
        <Group<FunctionKind>
          title="Function kind"
          options={FUNCTION_KINDS}
          value={view.kinds}
          counts={counts.kinds}
          onChange={(kinds) => onView({ ...view, kinds })}
        />
      )}
    </>
  );
}

/** The column beside the list, from `md` (a phone gets the Filters sheet instead). */
export function FilterColumn(props: FilterSectionsProps & { widthKey: string; onReset?: () => void }) {
  const [width, setWidth] = useWidth(props.widthKey);
  const [dragging, setDragging] = useState<number>();
  return (
    <nav
      aria-label="Log filters"
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        <FilterSections {...props} />
      </div>
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
