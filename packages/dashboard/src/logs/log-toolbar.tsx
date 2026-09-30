// The Logs toolbar (STUDY-12 §7): which functions, which types, text; pause / resume; clear.
import { Button } from "@bunvex/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bunvex/ui/components/dropdown-menu";
import { Input } from "@bunvex/ui/components/input";
import { ChevronDown, Pause, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { LOG_TYPES, type LogType, type LogView } from "./log-filter.ts";
import type { LogLines } from "./use-logs.ts";

/** A choice of several values, or all of them ("all" also takes in values that appear later). */
function PickMany<T extends string>(props: {
  label: string;
  /** "functions" → "All functions", "2 functions". */
  noun: string;
  options: readonly T[];
  value: T[] | "all";
  onChange: (value: T[] | "all") => void;
}) {
  const { options, value } = props;
  const chosen = value === "all" ? options : value;
  const toggle = (o: T, on: boolean) => {
    const next = on ? [...chosen, o] : chosen.filter((x) => x !== o);
    props.onChange(options.every((x) => next.includes(x)) ? "all" : next);
  };
  const summary =
    value === "all" ? `All ${props.noun}` : value.length === 1 ? value[0] : `${value.length} ${props.noun}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-label={`${props.label}: ${summary}`}
            className="min-w-36 justify-between"
          />
        }
      >
        <span className="truncate">{summary}</span>
        <ChevronDown aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-auto min-w-48">
        <DropdownMenuCheckboxItem checked={value === "all"} onCheckedChange={(on) => props.onChange(on ? "all" : [])}>
          All {props.noun}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {options.map((o) => (
          <DropdownMenuCheckboxItem key={o} checked={chosen.includes(o)} onCheckedChange={(on) => toggle(o, on)}>
            <span className="font-mono">{o}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function LogToolbar(props: {
  view: LogView;
  onView: (view: LogView) => void;
  /** Function paths to choose from; none on a single function's logs. */
  functions?: string[];
  logs: LogLines;
}) {
  const { view, onView, logs } = props;
  // the text applies 200 ms after the last keystroke, as in Convex's dashboard
  const [text, setText] = useState(view.text);
  useEffect(() => setText(view.text), [view.text]);
  useEffect(() => {
    if (text === view.text) return;
    const t = setTimeout(() => onView({ ...view, text }), 200);
    return () => clearTimeout(t);
  }, [text, view, onView]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {props.functions && (
        <PickMany
          label="Functions"
          noun="functions"
          options={props.functions}
          value={view.functions}
          onChange={(functions) => onView({ ...view, functions })}
        />
      )}
      <PickMany<LogType>
        label="Types"
        noun="types"
        options={LOG_TYPES}
        value={view.types}
        onChange={(types) => onView({ ...view, types })}
      />
      <Input
        type="search"
        aria-label="Filter logs"
        placeholder="Filter logs…"
        className="h-8 w-64"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <span className="ml-auto flex items-center gap-2">
        <Button variant="outline" size="sm" aria-pressed={logs.paused} onClick={() => logs.setPaused(!logs.paused)}>
          {logs.paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
          {logs.paused ? (logs.waiting > 0 ? `Resume (${logs.waiting} new)` : "Resume") : "Pause"}
        </Button>
        {logs.cleared > 0 && (
          <Button variant="ghost" size="sm" onClick={logs.unclear}>
            Show {logs.cleared} cleared
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={logs.lines.length === 0} onClick={logs.clear}>
          Clear
        </Button>
      </span>
    </div>
  );
}
