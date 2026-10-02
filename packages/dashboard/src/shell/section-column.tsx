// The section column (UI-01 §23, the dashboard's design language): one per screen, to the left of its
// content — the screen's name and primary action, its pages in labelled groups, the current page's filters
// (groups of checkboxes or radios, each choice with how many loaded rows it holds, in text). Below its
// breakpoint it is a sheet behind a button in Bar 1.
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

/** A link in the column's nav (the current one is marked by the router's aria-current). */
export const SECTION_ITEM =
  "flex h-8 items-center gap-2 border-l-2 border-transparent px-3 text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-[current=page]:border-foreground aria-[current=page]:bg-muted aria-[current=page]:font-medium";
const GROUP_LABEL = "px-3 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase";

/**
 * A screen's section column (UI-01 §23): to the left of its content — fixed, resizable from its right edge,
 * its width kept in this browser. On top, 44 px (Bar 1's line): the screen's name and its primary action;
 * then the screen's nav groups (`SectionNav`), then the current page's filters (`SectionFilters`). Hidden
 * below `from` (md by default): the screen offers the same content in a sheet (`useSectionSheet`).
 */
export function SectionColumn(props: {
  /** The screen's name, e.g. "Logs". */
  title: ReactNode;
  /** The primary action ("+ New …", "Upload"). */
  action?: ReactNode;
  widthKey: string;
  from?: "md" | "lg";
  children: ReactNode;
}) {
  const [width, setWidth] = useWidth(props.widthKey);
  const [dragging, setDragging] = useState<number>();
  return (
    <div
      data-slot="section-column"
      className={cn("relative hidden shrink-0 flex-col border-r", props.from === "lg" ? "lg:flex" : "md:flex")}
      style={{ width: dragging ?? width }}
    >
      <div data-slot="section-column-header" className="flex min-h-11 items-center gap-2 border-b px-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{props.title}</h2>
        {props.action}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">{props.children}</div>
      <ResizeHandle
        label="Resize the column"
        value={dragging ?? width}
        min={MIN}
        max={MAX}
        onDrag={setDragging}
        onCommit={(w) => {
          setDragging(undefined);
          setWidth(w);
        }}
      />
    </div>
  );
}

/** The screen's pages, in labelled groups (a group may have no label). */
export function SectionNav(props: { label: string; groups: { label?: string; items: ReactNode }[] }) {
  return (
    <nav aria-label={props.label}>
      {props.groups.map((g, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: groups are fixed per screen
        <div key={i}>
          {g.label ? <h3 className={GROUP_LABEL}>{g.label}</h3> : <div className="pt-2" />}
          <ul>{g.items}</ul>
        </div>
      ))}
    </nav>
  );
}

/** The current page's filters, under the nav: a "Filters" group with Reset, then the facets. */
export function SectionFilters(props: {
  /** The landmark's name, e.g. "Log filters". */
  label: string;
  onReset?: () => void;
  children: ReactNode;
}) {
  return (
    <nav aria-label={props.label}>
      <div className="flex items-center justify-between pr-3">
        <h3 className={GROUP_LABEL}>Filters</h3>
        {props.onReset && (
          <button
            type="button"
            className="pt-2 text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={props.onReset}
          >
            Reset
          </button>
        )}
      </div>
      {props.children}
    </nav>
  );
}

/** Below the column's breakpoint: a button for Bar 1, and the sheet it opens with the column's content. */
export function useSectionSheet(props: {
  kind: string;
  /** The button's and the sheet's name; "Filters" by default. */
  label?: string;
  from?: "md" | "lg";
  onReset?: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const label = props.label ?? "Filters";
  const button = (
    <Button
      variant="outline"
      size="sm"
      className={props.from === "lg" ? "lg:hidden" : "md:hidden"}
      aria-pressed={open}
      onClick={() => setOpen(!open)}
    >
      <ListFilter aria-hidden="true" />
      {label}
    </Button>
  );
  const sheet = open && (
    <Panel kind={props.kind} title={label} onClose={() => setOpen(false)}>
      {/* a picked page closes the sheet, as the main menu does */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the click is the link's; this only listens */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Enter on a link is a click */}
      <div className="-mx-4 -mt-4" onClick={(e) => (e.target as Element).closest("a") && setOpen(false)}>
        {props.children}
      </div>
      {props.onReset && (
        <Button variant="outline" size="sm" className="mt-4" onClick={props.onReset}>
          Reset filters
        </Button>
      )}
    </Panel>
  );
  return { button, sheet, close: () => setOpen(false) };
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
            aria-label={`All: ${props.title}`}
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
  /** "Only this one", shown on hover and focus (UX2-23). */
  onOnly?: () => void;
  onlyLabel?: string;
}) {
  const id = useId();
  return (
    <li className="group/choice flex items-center gap-2 px-3 py-1 hover:bg-muted/50">
      <Checkbox id={id} checked={props.checked} onCheckedChange={(on) => props.onChange(on === true)} />
      <label htmlFor={id} className={cn("min-w-0 flex-1 cursor-pointer truncate", props.mono && "font-mono text-xs")}>
        {props.label}
      </label>
      {props.onOnly && (
        <button
          type="button"
          aria-label={props.onlyLabel}
          className="text-xs text-muted-foreground underline-offset-2 opacity-0 group-hover/choice:opacity-100 hover:text-foreground hover:underline focus-visible:opacity-100"
          onClick={props.onOnly}
        >
          Only
        </button>
      )}
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
  /** Group the choices under small headings (in the options' order of first appearance). */
  groupOf?: (o: T) => string;
}) {
  const chosen = props.value === "all" ? props.options : props.value;
  const groups = props.groupOf
    ? [...new Set(props.options.map(props.groupOf))].map((g) => ({
        title: g,
        options: props.options.filter((o) => props.groupOf!(o) === g),
      }))
    : [{ title: undefined, options: props.options }];
  const set = (o: T, on: boolean) => {
    const next = on ? [...chosen, o] : chosen.filter((x) => x !== o);
    props.onChange(props.options.every((x) => next.includes(x)) ? "all" : next);
  };
  return (
    <FacetSection title={props.title} onAll={props.value !== "all" ? () => props.onChange("all") : undefined}>
      {groups.map((g) => (
        <FacetGroupList key={g.title ?? ""} title={g.title}>
          {g.options.map((o) => (
            <Choice
              key={o}
              label={props.label?.(o) ?? o}
              mono={props.mono}
              checked={chosen.includes(o)}
              count={props.counts.get(o) ?? 0}
              onChange={(on) => set(o, on)}
              onOnly={props.options.length > 2 ? () => props.onChange([o]) : undefined}
              onlyLabel={`Only ${o}`}
            />
          ))}
        </FacetGroupList>
      ))}
    </FacetSection>
  );
}

function FacetGroupList(props: { title?: string; children: ReactNode }) {
  if (!props.title) return <ul className="text-sm">{props.children}</ul>;
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="px-3 pt-1.5 text-[11px] text-muted-foreground">{props.title}</legend>
      <ul className="text-sm">{props.children}</ul>
    </fieldset>
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
