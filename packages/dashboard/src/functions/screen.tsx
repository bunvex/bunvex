// The Functions screen (STUDY-12 §7, UI-01 §13.2): the deployment's modules as a tree beside the open
// function — `?function=<module:name>` in the URL, as in Convex — with its kind, visibility, path and its
// logs. No statistics yet: the server has no app metrics (STUDY-12 L1).
import { Button } from "@bunvex/ui/components/button";
import { CopyButton } from "@bunvex/ui/components/copy-button";
import { Input } from "@bunvex/ui/components/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@bunvex/ui/components/tabs";
import { cn } from "@bunvex/ui/lib/utils";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ChevronRight, FileCode2, Folder, Play } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { functionsQuery } from "../data/queries.ts";
import type { FunctionInfo } from "../data-source.ts";
import { LogsView, useLogViewInUrl } from "../logs/screen.tsx";
import { useLogLines } from "../logs/use-logs.ts";
import { FunctionStats } from "../metrics/function-stats.tsx";
import { DashLink, type FunctionsSearch, functionsRoute } from "../router.tsx";
import { useRunner } from "../runner/context.tsx";
import { BAR1 } from "../shell/bars.ts";
import { displayValidator } from "../validators.ts";
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
  // the open function in view inside the tree: stacked on a phone, the tree is short, and the open row
  // otherwise showed as a sliver at its bottom edge (UX-19)
  const list = useRef<HTMLUListElement>(null);
  // a block body: scrollIntoView returns a Promise in recent browsers, and an effect may only return a cleanup
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the open function changes
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({ block: "nearest" });
  }, [current]);
  return (
    <nav
      aria-label="Functions"
      className="flex max-h-72 shrink-0 flex-col border-b lg:max-h-none lg:w-64 lg:border-r lg:border-b-0"
    >
      {/* on Bar 1's line (44 px), as the filter columns' headers */}
      <div className="flex min-h-11 items-center border-b px-3">
        <label htmlFor={searchId} className="sr-only">
          Search functions
        </label>
        <Input
          id={searchId}
          type="search"
          className="h-7"
          placeholder="Search functions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <ul ref={list} className="flex-1 overflow-y-auto py-2">
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

/** Up to this many lines show at once; a longer validator scrolls, and says so (UX-13). */
const VALIDATOR_LINES = 12;

/** A validator's code: long lines wrap with a hanging indent (UX-12); past 12 lines it scrolls, with a note. */
export function ValidatorCode({ code }: { code: string }) {
  const lines = code.split("\n").length;
  const noteId = useId();
  const long = lines > VALIDATOR_LINES;
  return (
    <>
      <pre
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a region that scrolls must be reachable by keyboard
        tabIndex={0}
        aria-describedby={long ? noteId : undefined}
        // 12 lines of text-xs (1rem each) plus the padding
        className="max-h-[13rem] overflow-auto border bg-muted/40 p-2 pl-6 -indent-4 font-mono text-xs break-words whitespace-pre-wrap"
      >
        {code}
      </pre>
      {long && (
        <p id={noteId} className="mt-1 text-xs text-muted-foreground">
          {lines} lines: scroll for the rest.
        </p>
      )}
    </>
  );
}

/** The declared arguments and return validators, as the `v.*` code (STUDY-12 V1). */
function FunctionValidators({ fn }: { fn: FunctionInfo }) {
  const shown = [
    { title: "Arguments", v: fn.args, none: "None declared: any arguments are accepted." },
    { title: "Returns", v: fn.returns, none: "None declared." },
  ];
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {shown.map(({ title, v, none }) => (
        <section key={title} aria-label={`${title} validator`} className="min-w-0">
          <h2 className="mb-1 text-sm font-medium">{title}</h2>
          {v ? <ValidatorCode code={displayValidator(v)} /> : <p className="text-sm text-muted-foreground">{none}</p>}
        </section>
      ))}
    </div>
  );
}

function FunctionView({ fn }: { fn: FunctionInfo }) {
  const scope = useQueryScope();
  const search = functionsRoute.useSearch();
  const navigate = functionsRoute.useNavigate();
  // Statistics first, as Convex; a link with log filters opens the logs
  const tab = search.tab ?? (search.type || search.q || search.range || search.from ? "logs" : "statistics");
  // the log filters in the URL (`?function=<the open one>&type=&q=&range=` or `&from=&to=`) and kept in this
  // browser per function; the list is only this function's, so there is no function or kind filter
  const [view, setView] = useLogViewInUrl(
    `bunvex:function-logs:${scope.scope}:${fn.path}`,
    { type: search.type, q: search.q, range: search.range, from: search.from, to: search.to },
    ({ type, q, range, from, to }, replace) =>
      navigate({
        search: (s: FunctionsSearch): FunctionsSearch => ({ function: s.function, type, q, range, from, to, tab }),
        replace,
      }),
  );
  const filter = useMemo(() => ({ function: fn.path }), [fn.path]);
  const logs = useLogLines(filter);
  const { module, name } = splitPath(fn.path);
  const runner = useRunner();
  return (
    <Tabs
      value={tab}
      onValueChange={(t) =>
        navigate({ search: (s: FunctionsSearch): FunctionsSearch => ({ ...s, tab: t as "statistics" | "logs" }) })
      }
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-0"
    >
      {/* Bar 1 (UI-01 §22.5): the function, its two tabs, its path and Run — 44 px, as on the grid screens */}
      <div className={BAR1}>
        <h1 className="font-mono text-base font-semibold tracking-tight">{name}</h1>
        <span className="text-sm text-muted-foreground">
          {describeFunction(fn)} in <span className="font-mono text-xs">{module}</span>
        </span>
        <TabsList aria-label={`${fn.path}: statistics or logs`} className="mx-2">
          <TabsTrigger value="statistics">Statistics</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>
        <span className="ml-auto flex min-w-0 flex-wrap items-center gap-1">
          <code className="font-mono text-xs break-all">{fn.path}</code>
          <CopyButton text={fn.path} label="Copy function path" iconOnly />
          {runner.available && (
            <Button variant="outline" size="sm" onClick={() => runner.open(fn.path)}>
              <Play aria-hidden="true" />
              Run
            </Button>
          )}
        </span>
      </div>
      {/* the declared validators with the statistics: the Logs tab keeps the whole height for its list */}
      <TabsContent
        value="statistics"
        className="flex flex-col gap-6 p-4 md:p-6 lg:min-h-0 lg:flex-1 lg:overflow-y-auto"
      >
        <FunctionValidators fn={fn} />
        <FunctionStats fn={fn} />
      </TabsContent>
      {/* the rest of the screen's height (a screen's own on narrower screens): the list scrolls inside (UI-01 §22.4) */}
      <TabsContent value="logs" className="flex h-[calc(100svh-3rem)] min-h-0 flex-none lg:h-auto lg:flex-1">
        <LogsView
          key={fn.path}
          label={`Log lines of ${fn.path}`}
          logs={logs}
          view={view}
          onView={setView}
          widthKey="bunvex-dashboard:function-logs-filters-width"
          exportPrefix={`logs-${fn.path.replace(/[^\w.-]+/g, "_")}`}
        />
      </TabsContent>
    </Tabs>
  );
}

export function FunctionsScreen() {
  const { data: functions } = useSuspenseQuery(functionsQuery(useQueryScope()));
  const search = functionsRoute.useSearch();
  const fn = functions.find((f) => f.path === search.function);
  return (
    // full-bleed inside <main>: the sidebar and the details panel run to its edges
    // from lg a screen's height: the tree and the function scroll inside, as the Database screen's
    <div className="-m-4 flex min-h-[calc(100svh-3rem)] flex-col md:-m-6 lg:h-[calc(100svh-3rem)] lg:flex-row">
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
