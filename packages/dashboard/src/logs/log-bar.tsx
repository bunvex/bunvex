// The Logs screen's first bar (UI-01 §22.4): as tall as the docked panel's header (44 px), so their bottom
// lines run on across — the heading (on the Logs screen), the text filter, how many lines are shown, Live
// (pause and resume, with how many lines wait), Export (the shown lines as JSON Lines) and Clear. Below `md`
// a Filters button opens the filter column as a sheet. Beside a docked panel the bar is narrow: Export and
// Clear keep their icons (a container query).
import { Button } from "@bunvex/ui/components/button";
import { Input } from "@bunvex/ui/components/input";
import { cn } from "@bunvex/ui/lib/utils";
import { Download, Eraser, Pause, Play } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { LogView } from "./log-filter.ts";
import type { LogLines } from "./use-logs.ts";

export function LogBar(props: {
  heading?: ReactNode;
  view: LogView;
  onView: (view: LogView) => void;
  logs: LogLines;
  /** "39 lines", "12 of 39 lines". */
  count: string;
  onExport: () => void;
  canExport: boolean;
  /** The Filters button (phones), from `useFiltersSheet`. */
  filtersButton?: ReactNode;
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
  const label = "sr-only @2xl/logs:not-sr-only";

  return (
    <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-1 md:px-6">
      {props.heading}
      {props.filtersButton}
      <Input
        type="search"
        aria-label="Search logs"
        placeholder="Search logs…"
        className="h-7 w-44 min-w-0 flex-1 @2xl/logs:w-64 @2xl/logs:flex-none"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <span className="text-sm whitespace-nowrap text-muted-foreground tabular-nums" aria-live="polite">
        {logs.loadingOlder ? "Loading older lines…" : props.count}
      </span>
      <span className="ml-auto flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          title={logs.paused ? "Show new lines as they arrive" : "Stop new lines from arriving"}
          onClick={() => logs.setPaused(!logs.paused)}
        >
          {logs.paused ? (
            <Play aria-hidden="true" />
          ) : (
            <span aria-hidden="true" className="relative mx-0.5 flex size-2">
              <span className="absolute inline-flex size-full rounded-full bg-success opacity-60 motion-safe:animate-ping" />
              <span className="relative inline-flex size-2 rounded-full bg-success" />
            </span>
          )}
          {logs.paused ? (logs.waiting > 0 ? `Resume (${logs.waiting} new)` : "Resume") : "Live"}
          {!logs.paused && (
            <>
              <span className="sr-only">: pause</span>
              <Pause aria-hidden="true" className="text-muted-foreground" />
            </>
          )}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!props.canExport}
          onClick={props.onExport}
          title="Export the shown lines as JSON Lines"
        >
          <Download aria-hidden="true" />
          <span className={label}>Export</span>
        </Button>
        {logs.cleared > 0 && (
          <Button variant="ghost" size="sm" onClick={logs.unclear}>
            Show {logs.cleared} cleared
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={logs.lines.length === 0}
          onClick={logs.clear}
          title="Hide the lines loaded so far"
        >
          <Eraser aria-hidden="true" />
          <span className={cn(label)}>Clear</span>
        </Button>
      </span>
    </div>
  );
}
