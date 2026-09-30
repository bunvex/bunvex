// The function runner (STUDY-12 §7, UI-01 §13.3): docked below every screen, as in Convex. Pick a function,
// write its arguments as a JavaScript literal (the code editor, as for documents), run it once with the Run
// button or Ctrl+Enter, and read its value, or its error, with the lines it logged. A read-only credential
// runs queries only. A function that declares an arguments validator starts from a template of it, and the
// arguments are checked against it as they are typed (STUDY-12 V1), as Convex's runner does. A query, when the
// source can watch one (`watchFunction`), is not run but subscribed, as in Convex (STUDY-12 §10, R1): its result
// follows the arguments while they are valid, and updates as the data changes; with invalid ones it pauses.
import { Button } from "@bunvex/ui/components/button";
import { Checkbox } from "@bunvex/ui/components/checkbox";
import { CodeEditor } from "@bunvex/ui/components/code-editor";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@bunvex/ui/components/select";
import { cn } from "@bunvex/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Play, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { capabilitiesQuery, functionsQuery } from "../data/queries.ts";
import {
  type FunctionInfo,
  type FunctionRun,
  toDataSourceError,
  type ValidatorJson,
  type Value,
} from "../data-source.ts";
import { formatLiteral, parseLiteralLocated, UNSET } from "../database/literal.ts";
import { describeFunction } from "../functions/tree.ts";
import { formatDuration } from "../logs/log-list.tsx";
import { defaultValueFor, validateValue } from "../validators.ts";
import { appendRunHistory, type RunHistoryEntry, readRunHistory } from "./history.ts";
import { DEFAULT_IDENTITY, parseIdentity } from "./identity.ts";

type Args =
  | { ok: true; args: Record<string, Value> }
  | { ok: false; error: string; offset?: number; more?: { message: string; offset: number }[] };

/**
 * A function's arguments: one object literal (`{}` for none) — and, when the function declares an arguments
 * validator, one that fits it (the first misfit, with where it is).
 */
export function parseArgs(text: string, validator?: ValidatorJson): Args {
  if (text.trim() === "") text = "{}";
  const r = parseLiteralLocated(text);
  if (!r.ok) return { ok: false, error: r.error, offset: r.offset };
  const v = r.value;
  if (v === UNSET || typeof v !== "object" || v === null || Array.isArray(v) || "$integer" in v || "$bytes" in v)
    return { ok: false, error: "The arguments are one object: { name: value, … }", offset: 0 };
  // every misfit is underlined, as in Convex's runner; the first one is also said below the box
  const issues = (validator ? validateValue(validator, v) : []).map((issue) => {
    const at = r.place(issue.path);
    return { message: issue.message, offset: (issue.at === "key" ? at?.key : undefined) ?? at?.value ?? 0 };
  });
  const [first, ...more] = issues;
  if (first) return { ok: false, error: first.message, offset: first.offset, ...(more.length > 0 && { more }) };
  return { ok: true, args: v as Record<string, Value> };
}

/** What the arguments box starts with: a template of the declared validator, or `{}`. */
export function argsTemplate(fn: FunctionInfo | undefined): string {
  const v = fn?.args ? defaultValueFor(fn.args) : undefined;
  return v === undefined ? "{}" : formatLiteral(v, "  ");
}

// the arguments typed for each function, while the page is open
const drafts = new Map<string, string>();
// the user acted as, one for every function, as in Convex (STUDY-12 §10.3), while the page is open
const acting = { on: false, text: DEFAULT_IDENTITY };

type Outcome = { run: FunctionRun } | { failed: string };

export function FunctionRunner(props: { path?: string; onPath: (path: string) => void; onClose: () => void }) {
  const scope = useQueryScope();
  const { data: functions = [] } = useQuery(functionsQuery(scope));
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  const fn: FunctionInfo | undefined = functions.find((f) => f.path === props.path) ?? functions[0];
  const [text, setText] = useState(() => drafts.get(fn?.path ?? "") ?? argsTemplate(fn));
  const [outcome, setOutcome] = useState<Outcome>();
  const [running, setRunning] = useState(false);
  const titleId = useId();
  const pickerId = useId();
  const checkId = useId();
  const args = parseArgs(text, fn?.args);
  const readOnly = caps?.readOnly ?? false;
  const blocked = fn !== undefined && readOnly && fn.kind !== "query";
  const live = fn?.kind === "query" && typeof scope.source.watchFunction === "function";
  const canActAs = caps?.operations.includes("actAsUser") ?? false;
  const [actAs, setActAs] = useState(acting.on);
  const [identityText, setIdentityText] = useState(acting.text);
  const identity = actAs && canActAs ? parseIdentity(identityText) : undefined;
  const identityOk = identity === undefined || identity.ok;
  const runAs = identity?.ok ? identity.identity : undefined;
  const argsKey = args.ok && identityOk ? JSON.stringify([args.args, runAs ?? null]) : null;
  const identityId = useId();
  const identityCheckId = useId();
  const actAsId = useId();
  const toggleActAs = (on: boolean) => {
    acting.on = on;
    setActAs(on);
  };
  const setIdentity = (t: string) => {
    acting.text = t;
    setIdentityText(t);
  };
  const [waiting, setWaiting] = useState(false);
  // a mutation's or an action's past arguments (a query follows its own): Previous / Next step through them
  const [history, setHistory] = useState<RunHistoryEntry[]>(() =>
    fn && fn.kind !== "query" ? readRunHistory(scope.scope, fn.path) : [],
  );
  const [historyAt, setHistoryAt] = useState(0);
  const showHistory = (i: number) => {
    const entry = history[i];
    if (!entry || !fn) return;
    const t = formatLiteral(entry.args, "  ");
    setText(t);
    drafts.set(fn.path, t);
    setHistoryAt(i);
    // the run's user comes back with its arguments, as in Convex
    if (entry.identity) setIdentity(formatLiteral(entry.identity, "  "));
    toggleActAs(entry.identity !== undefined);
  };

  // a watched query: subscribed with the current (valid) arguments; the last result stays until the next
  // biome-ignore lint/correctness/useExhaustiveDependencies: argsKey stands for args.args
  useEffect(() => {
    if (!live || !fn || !args.ok || !identityOk) return;
    setWaiting(true);
    return scope.source.watchFunction!(
      fn.path,
      args.args,
      (run) => {
        setOutcome({ run });
        setWaiting(false);
      },
      (e) => {
        setOutcome({ failed: e.message });
        setWaiting(false);
      },
      runAs && { identity: runAs },
    );
  }, [live, fn?.path, argsKey, scope.source]);

  // the shell keys the runner by path: another function starts afresh, with its own draft
  const pick = (path: string) => props.onPath(path);

  const run = async () => {
    // a watched query is not run: it follows its arguments
    if (!fn || !args.ok || !identityOk || blocked || live || !scope.source.runFunction) return;
    setRunning(true);
    // a query keeps none, even run once (without watchFunction)
    if (fn.kind !== "query") {
      setHistory(
        appendRunHistory(scope.scope, fn.path, {
          args: args.args,
          startedAt: Date.now(),
          ...(runAs && { identity: runAs }),
        }),
      );
      setHistoryAt(0);
    }
    try {
      setOutcome({ run: await scope.source.runFunction(fn.path, args.args, runAs && { identity: runAs }) });
    } catch (e) {
      setOutcome({ failed: toDataSourceError(e).message });
    }
    setRunning(false);
  };

  const r = outcome && "run" in outcome ? outcome.run : undefined;
  return (
    <section
      aria-labelledby={titleId}
      className="fixed inset-x-0 bottom-0 z-20 flex h-[45svh] flex-col border-t bg-background shadow-[0_-4px_12px_rgb(0_0_0/0.06)] md:left-52"
    >
      <header className="flex h-11 shrink-0 items-center gap-3 border-b px-4">
        <h2 id={titleId} className="font-medium">
          Run a function
        </h2>
        <span id={pickerId} className="sr-only">
          Function
        </span>
        <Select
          items={functions.map((f) => ({ value: f.path, label: f.path }))}
          value={fn?.path ?? null}
          onValueChange={(v) => pick(v as string)}
        >
          <SelectTrigger aria-labelledby={pickerId} className="h-8 min-w-56">
            <SelectValue placeholder="Pick a function" />
          </SelectTrigger>
          <SelectContent>
            {functions.map((f) => (
              <SelectItem key={f.path} value={f.path}>
                <span className="font-mono">{f.path}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {fn && <span className="text-sm text-muted-foreground">{describeFunction(fn)}</span>}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label="Close the runner"
          onClick={props.onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
        <form
          className="flex min-h-0 flex-col gap-2 border-b p-4 md:border-r md:border-b-0"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          {!live && history.length > 0 && (
            <div className="flex items-center justify-end gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Previous arguments"
                disabled={historyAt + 1 >= history.length}
                onClick={() => showHistory(historyAt + 1)}
              >
                <ArrowLeft aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Next arguments"
                disabled={historyAt <= 0}
                onClick={() => showHistory(historyAt - 1)}
              >
                <ArrowRight aria-hidden="true" />
              </Button>
            </div>
          )}
          <CodeEditor
            label="Arguments"
            multiline
            height={140}
            value={text}
            onChange={(t) => {
              setText(t);
              if (fn) drafts.set(fn.path, t);
            }}
            error={args.ok ? undefined : { message: args.error, offset: args.offset }}
            moreErrors={args.ok ? undefined : args.more}
            describedBy={checkId}
            onSubmit={() => void run()}
          />
          <p id={checkId} aria-live="polite" className="min-h-5 text-sm">
            {!args.ok ? (
              <span className="text-destructive">
                {args.error}
                {live && " The result is paused until the arguments are fixed."}
              </span>
            ) : live ? (
              <span className="flex items-center gap-2 text-muted-foreground">
                <span aria-hidden="true" className="size-2 rounded-full bg-success motion-safe:animate-pulse" />
                Subscribed: the result updates as the data changes.
              </span>
            ) : blocked ? (
              <span className="text-muted-foreground">A read-only credential runs queries only.</span>
            ) : (
              <span className="text-muted-foreground">Ctrl+Enter runs it.</span>
            )}
          </p>
          <div className="flex flex-col gap-1">
            <span className="flex w-fit items-center gap-2 text-sm">
              <Checkbox
                id={actAsId}
                checked={actAs && canActAs}
                disabled={!canActAs}
                onCheckedChange={(on) => toggleActAs(on === true)}
                aria-describedby={canActAs ? undefined : identityId}
              />
              <label htmlFor={actAsId}>Act as a user</label>
            </span>
            {!canActAs ? (
              <p id={identityId} className="text-xs text-muted-foreground">
                This credential cannot act as a user.
              </p>
            ) : (
              actAs && (
                <>
                  <CodeEditor
                    label="User identity"
                    multiline
                    height={90}
                    value={identityText}
                    onChange={setIdentity}
                    error={identity && !identity.ok ? { message: identity.error, offset: identity.offset } : undefined}
                    describedBy={identityCheckId}
                  />
                  <p id={identityCheckId} aria-live="polite" className="min-h-4 text-xs">
                    {identity && !identity.ok ? (
                      <span className="text-destructive">{identity.error}</span>
                    ) : (
                      <span className="text-muted-foreground">
                        What <code className="font-mono">ctx.auth.getUserIdentity()</code> returns: subject and issuer,
                        then any claims.
                      </span>
                    )}
                  </p>
                </>
              )
            )}
          </div>
          {!live && (
            <div>
              <Button type="submit" size="sm" disabled={!fn || !args.ok || !identityOk || blocked || running}>
                <Play aria-hidden="true" />
                {running ? "Running…" : `Run ${fn?.kind ?? "function"}`}
              </Button>
            </div>
          )}
        </form>
        <div className="min-h-0 overflow-y-auto p-4" aria-live="polite" aria-busy={running || waiting}>
          {!outcome ? (
            <p className="text-sm text-muted-foreground">{live && waiting ? "Loading…" : "The result shows here."}</p>
          ) : "failed" in outcome ? (
            <p role="alert" className="text-sm text-destructive">
              {outcome.failed}
            </p>
          ) : (
            r && (
              <>
                <p className={cn("text-sm", r.error ? "text-destructive" : "text-muted-foreground")}>
                  {r.error ? "Failed" : "Succeeded"} in {formatDuration(r.durationMs)}
                </p>
                <h3 className="mt-3 mb-1 text-sm font-medium">{r.error ? "Error" : "Result"}</h3>
                <pre
                  className={cn(
                    "overflow-x-auto border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap",
                    r.error && "text-destructive",
                  )}
                >
                  {r.error
                    ? `${r.error.message}${r.error.data === undefined ? "" : `\n${formatLiteral(r.error.data, "  ")}`}`
                    : formatLiteral(r.value ?? null, "  ")}
                </pre>
                {r.logLines.length > 0 && (
                  <>
                    <h3 className="mt-3 mb-1 text-sm font-medium">Logs</h3>
                    <ol className="flex flex-col border font-mono text-xs">
                      {r.logLines.map((l, i) => (
                        <li
                          // biome-ignore lint/suspicious/noArrayIndexKey: the lines of one run, in order, never reordered
                          key={i}
                          className={cn(
                            "flex gap-3 border-b px-2 py-1 last:border-b-0",
                            l.level === "error" && "text-destructive",
                          )}
                        >
                          <span className="shrink-0 text-muted-foreground uppercase">{l.level}</span>
                          <span className="min-w-0 break-words">{l.message}</span>
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </>
            )
          )}
        </div>
      </div>
    </section>
  );
}
