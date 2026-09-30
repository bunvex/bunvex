// The Functions screen (STUDY-12 §7, UI-01 §13.2): the deployment's modules as a tree beside the open
// function — `?function=<module:name>` in the URL, as in Convex — with its kind, visibility, path and its
// logs. No statistics yet: the server has no app metrics (STUDY-12 L1).
import { CopyButton } from "@bunvex/ui/components/copy-button";
import { Input } from "@bunvex/ui/components/input";
import { cn } from "@bunvex/ui/lib/utils";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ChevronRight, FileCode2, Folder } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { functionsQuery } from "../data/queries.ts";
import type { FunctionInfo } from "../data-source.ts";
import { LogsView, useLogViewInUrl } from "../logs/screen.tsx";
import { useLogLines } from "../logs/use-logs.ts";
import { DashLink, type FunctionsSearch, functionsRoute } from "../router.tsx";
import { buildFunctionTree, describeFunction, type FunctionNode, matchFunctions, splitPath } from "./tree.ts";

const ITEM =
  "flex h-8 items-center gap-2 border-l-2 border-transparent pr-3 text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
const LINK = `${ITEM} aria-[current=page]:border-foreground aria-[current=page]:bg-muted aria-[current=page]:font-medium`;
const indent = (depth: number) => ({ paddingLeft: `${0.75 + depth * 0.875}rem` });

function Branch(props: {
  node: FunctionNode;
  depth: number;
  current?: string;
  /** Searching: every branch open. */
  forceOpen: boolean;
}) {
  const { node, depth } = props;
  const [open, setOpen] = useState(true);
  const expanded = props.forceOpen || open;
  const Icon = node.kind === "folder" ? Folder : FileCode2;
  return (
    <li>
      <button
        type="button"
        aria-expanded={expanded}
        className={cn(ITEM, "w-full text-left")}
        style={indent(depth)}
        onClick={() => setOpen(!expanded)}
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")}
          aria-hidden="true"
        />
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{node.name}</span>
      </button>
      {expanded && (
        <ul>
          {node.kind === "folder"
            ? node.children.map((c) => (
                <Branch
                  key={c.kind === "folder" ? c.path : c.module}
                  node={c}
                  depth={depth + 1}
                  current={props.current}
                  forceOpen={props.forceOpen}
                />
              ))
            : node.functions.map((f) => (
                <li key={f.path}>
                  <DashLink
                    link={{ to: "/functions", search: { function: f.path } }}
                    className={LINK}
                    style={indent(depth + 1.5)}
                    aria-current={f.path === props.current ? "page" : undefined}
                  >
                    <span
                      aria-hidden="true"
                      className="w-4 shrink-0 text-center font-mono text-[10px] text-muted-foreground uppercase"
                    >
                      {f.kind[0]}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{splitPath(f.path).name}</span>
                    <span className="sr-only">, {f.kind}</span>
                    {f.visibility === "internal" && <span className="text-xs text-muted-foreground">internal</span>}
                  </DashLink>
                </li>
              ))}
        </ul>
      )}
    </li>
  );
}

function FunctionsSidebar({ functions, current }: { functions: FunctionInfo[]; current?: string }) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const tree = useMemo(() => buildFunctionTree(matchFunctions(functions, query)), [functions, query]);
  return (
    <nav
      aria-label="Functions"
      className="flex max-h-72 shrink-0 flex-col border-b md:max-h-none md:w-64 md:border-r md:border-b-0"
    >
      <div className="p-3">
        <label htmlFor={searchId} className="sr-only">
          Search functions
        </label>
        <Input
          id={searchId}
          type="search"
          placeholder="Search functions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <ul className="flex-1 overflow-y-auto pb-3">
        {tree.map((n) => (
          <Branch
            key={n.kind === "folder" ? n.path : n.module}
            node={n}
            depth={0}
            current={current}
            forceOpen={query.trim() !== ""}
          />
        ))}
        {tree.length === 0 && (
          <li className="px-3 py-2 text-sm text-muted-foreground">No function matches “{query}”.</li>
        )}
      </ul>
    </nav>
  );
}

function FunctionView({ fn }: { fn: FunctionInfo }) {
  const scope = useQueryScope();
  // the log filters in the URL (`?function=<the open one>&type=&q=`) and kept in this browser per function;
  // the list is only this function's, so there is no function filter
  const search = functionsRoute.useSearch();
  const navigate = functionsRoute.useNavigate();
  const [view, setView] = useLogViewInUrl(
    `bunvex:function-logs:${scope.scope}:${fn.path}`,
    { type: search.type, q: search.q },
    ({ type, q }, replace) =>
      navigate({ search: (s: FunctionsSearch): FunctionsSearch => ({ function: s.function, type, q }), replace }),
  );
  const filter = useMemo(() => ({ function: fn.path }), [fn.path]);
  const logs = useLogLines(filter);
  const { module, name } = splitPath(fn.path);
  return (
    <LogsView
      key={fn.path}
      label={`Log lines of ${fn.path}`}
      logs={logs}
      view={view}
      onView={setView}
      header={
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h1 className="font-mono text-xl font-semibold tracking-tight">{name}</h1>
            <span className="text-sm text-muted-foreground">
              {describeFunction(fn)} in <span className="font-mono text-xs">{module}</span>
            </span>
            <span className="ml-auto flex items-center gap-1">
              <code className="font-mono text-xs">{fn.path}</code>
              <CopyButton text={fn.path} label="Copy the function's path" />
            </span>
          </div>
          <h2 className="text-sm font-medium">Logs</h2>
        </>
      }
    />
  );
}

export function FunctionsScreen() {
  const { data: functions } = useSuspenseQuery(functionsQuery(useQueryScope()));
  const search = functionsRoute.useSearch();
  const fn = functions.find((f) => f.path === search.function);
  return (
    // full-bleed inside <main>: the sidebar and the details panel run to its edges
    <div className="-m-4 flex min-h-[calc(100svh-3rem)] flex-col md:-m-6 md:flex-row">
      <FunctionsSidebar functions={functions} current={fn?.path} />
      {fn ? (
        <FunctionView key={fn.path} fn={fn} />
      ) : (
        <div className="flex-1 p-4 md:p-6">
          <h1 className="text-xl font-semibold tracking-tight">Functions</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {functions.length === 0
              ? "This deployment has no functions yet. They appear once code is pushed."
              : search.function
                ? `There is no function ${search.function}. Pick one on the left.`
                : "Pick a function on the left to see its details and its logs."}
          </p>
        </div>
      )}
    </div>
  );
}
