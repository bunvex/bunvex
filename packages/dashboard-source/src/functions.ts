// The Functions screen and the function runner over a deployment (STUDY-149 PR 4), as Convex's dashboard reads
// and runs them (STUDY-149 §1.2):
// - the list is `modules:listForAllComponents`, kept subscribed while someone watches (a push changes every
//   module's `sourcePackageId`, so a push is a new result), with each function's validators from
//   `_system/cli/modules:apiSpec` (Convex's dashboard reads the arguments validator of the open function with
//   `modules:argsValidator` and never shows the returns one; the contract carries both in the list);
// - the runner runs on clients of its own, as Convex's (`functionRunner/lib/client.ts`): signed in with the admin
//   key, acting as the user when asked (`setAdminAuth(key, identity)`); a query is subscribed (`watchQuery`), a
//   mutation or an action is a WebSocket request (`mutationInternal` / `actionInternal`), and the run's log lines
//   come with its result;
// - a custom test query is `POST /api/run_test_function`, the admin key in the body, as Convex's
//   (`useRunTestFunction`), with bunvex's builders' specifier (DV-390) and encoded format (DV-307).

import type { FunctionResult } from "@bunvex/client";
import {
  type CallOptions,
  type Capabilities,
  DataSourceError,
  type FunctionInfo,
  type FunctionKind,
  type FunctionRun,
  type LogLevel,
  type RunOptions,
  type Unsubscribe,
  type UserIdentity,
  type ValidatorJson,
  type Value,
} from "@bunvex/dashboard/data-source";
import { fromJsonValue, type JSONValue } from "@bunvex/values";
import { type AdminHttp, codeOfStatus } from "./admin-http.ts";
import { LiveGroup } from "./live.ts";
import { AdminSync, type AdminSyncOptions } from "./sync.ts";
import { encodeValue } from "./wire.ts";

const MODULES = "_system/frontend/modules:listForAllComponents";
const API_SPEC = "_system/cli/modules:apiSpec";

/** The function tester's builders (Convex's `convex:/_system/repl/wrappers.js`, DV-390), imported first. */
export const TEST_QUERY_PREAMBLE = 'import { query, internalQuery } from "bunvex:/_system/repl/wrappers.js";\n';

/** How many runner clients (one per identity the runner acts as) are kept open at most. */
export const MAX_RUNNER_CLIENTS = 4;

type ModuleJson = {
  functions: { name: string; lineno?: number; udfType: string; visibility: { kind: string } }[];
  sourcePackageId: string;
};
type SpecJson = { identifier?: string; functionType: string; args?: unknown; returns?: unknown };

const KINDS: Record<string, FunctionKind> = {
  Query: "query",
  Mutation: "mutation",
  Action: "action",
  HttpAction: "httpAction",
};
const LEVELS: Record<string, LogLevel> = { LOG: "info", INFO: "info", DEBUG: "debug", WARN: "warn", ERROR: "error" };

/**
 * A validator the push recorded, in the contract's form; `v.any()` — what a function declared without one
 * exports (Convex's `DEFAULT_ARGS_VALIDATOR`) — is none.
 */
function validatorOf(v: unknown): ValidatorJson | undefined {
  if (v === undefined || v === null) return undefined;
  const json = encodeValue(v) as unknown as ValidatorJson;
  return json.type === "any" ? undefined : json;
}

/**
 * The functions of the root's modules, as Convex's `generateFileTree` reads `listForAllComponents`
 * (`processAnalyzedModuleFunction`): a module's queries, mutations and actions at `module:name`, and its HTTP
 * routes under their own name, `METHOD /path` (Convex's identifier for one, in the tree, the logs and the
 * metrics), with the module that defines them.
 */
export function functionsOf(modules: [string | null, [string, ModuleJson][]][], spec: SpecJson[]): FunctionInfo[] {
  const validators = new Map(spec.filter((s) => s.identifier).map((s) => [s.identifier!, s]));
  const root = modules.find(([component]) => component === null)?.[1] ?? [];
  const out: FunctionInfo[] = [];
  for (const [path, module] of root)
    for (const f of module.functions) {
      const kind = KINDS[f.udfType];
      if (!kind) continue;
      const module = path.replace(/\.js$/, "");
      if (kind === "httpAction") {
        out.push({
          path: f.name,
          kind,
          module,
          visibility: "public",
          ...(f.lineno !== undefined && { line: f.lineno }),
        });
        continue;
      }
      const s = validators.get(`${path}:${f.name}`);
      const args = validatorOf(s?.args);
      const returns = validatorOf(s?.returns);
      out.push({
        path: `${module}:${f.name}`,
        kind,
        visibility: f.visibility.kind === "internal" ? "internal" : "public",
        ...(args && { args }),
        ...(returns && { returns }),
        ...(f.lineno !== undefined && { line: f.lineno }),
      });
    }
  return out;
}

/** A line of a run's log as the client gives it, `[LEVEL] message` (Convex's `entryLogLines`). */
export function runLogLine(line: string): { level: LogLevel; message: string } {
  const m = /^\[(LOG|DEBUG|INFO|WARN|ERROR)\] ([\s\S]*)/.exec(line);
  return { level: LEVELS[m?.[1] ?? "LOG"] ?? "info", message: m?.[2] ?? line };
}

/** A run's result in the contract's form: its value (`undefined` as null) or its error and data. */
export function runOf(r: FunctionResult, durationMs: number): FunctionRun {
  const logLines = r.logLines.map(runLogLine);
  if (r.success) return { value: encodeValue(r.value ?? null), logLines, durationMs };
  const data = (r as { errorData?: unknown }).errorData;
  return {
    error: { message: r.errorMessage, ...(data !== undefined && { data: encodeValue(data) }) },
    logLines,
    durationMs,
  };
}

/** The contract's arguments (int64 and bytes in their JSON encodings) as the client's values. */
const clientArgs = (args: Record<string, Value>) =>
  fromJsonValue(args as unknown as JSONValue) as Record<string, never>;

type Runner = { sync: AdminSync; watchers: number; used: number };

export class Functions {
  private readonly group: LiveGroup;
  private readonly runners = new Map<string, Runner>();
  private clock = 0;

  constructor(
    private readonly sync: AdminSync,
    private readonly http: AdminHttp,
    private readonly opts: AdminSyncOptions,
    private readonly capabilities: () => Promise<Capabilities>,
  ) {
    this.group = new LiveGroup(sync);
  }

  async listFunctions(o?: CallOptions): Promise<FunctionInfo[]> {
    const [modules, spec] = await Promise.all([
      this.group.read<[string | null, [string, ModuleJson][]][]>(
        MODULES,
        {},
        { list: "modules", first: true, pausable: false, signal: o?.signal },
      ),
      this.sync.query<SpecJson[]>(API_SPEC, { componentId: null }, o?.signal),
    ]);
    return functionsOf(modules, spec);
  }

  /** A push is a new module list: the watcher hears it (Convex's subscribed `listForAllComponents`). */
  watchFunctions(onChange: () => void, onError: (e: DataSourceError) => void): Unsubscribe {
    const off = this.group.watch(() => onChange(), onError);
    // the list is followed only once read: read it, so a watcher that comes first hears the next push
    this.listFunctions().catch((e: unknown) =>
      onError(e instanceof DataSourceError ? e : new DataSourceError("unavailable", String(e))),
    );
    return off;
  }

  /** The function at `path`, or `not_found`; and whether the caller may run it (`unauthorized` if not). */
  private async check(path: string, identity: UserIdentity | undefined, signal?: AbortSignal) {
    const [functions, caps] = await Promise.all([this.listFunctions({ signal }), this.capabilities()]);
    const fn = functions.find((f) => f.path === path);
    if (!fn) throw new DataSourceError("not_found", `Could not find function "${path}".`);
    // Convex's runner offers queries, mutations and actions only (`SUPPORTED_FUNCTION_TYPES`): a route is called
    // at its URL
    if (fn.kind === "httpAction")
      throw new DataSourceError("invalid_request", `${path} is an HTTP action: call it at its URL.`);
    if (!caps.operations.includes("runFunctions"))
      throw new DataSourceError("unauthorized", "This credential cannot run functions.");
    if (caps.readOnly && fn.kind !== "query")
      throw new DataSourceError("unauthorized", `A read-only credential cannot run a ${fn.kind}.`);
    if (identity && !caps.operations.includes("actAsUser"))
      throw new DataSourceError("unauthorized", "This credential cannot act as a user.");
    return fn;
  }

  /**
   * The runner's client for an identity (none: the admin itself), as Convex's second client. One per identity, so
   * runs as different users can overlap; the least recently used idle one is closed past `MAX_RUNNER_CLIENTS`.
   */
  private runner(identity: UserIdentity | undefined): Runner {
    const key = identity === undefined ? "" : JSON.stringify(identity);
    let r = this.runners.get(key);
    if (!r) {
      r = {
        sync: new AdminSync({ ...this.opts, ...(identity && { impersonating: identity }) }),
        watchers: 0,
        used: 0,
      };
      this.runners.set(key, r);
      const idle = [...this.runners.entries()].filter(([k, x]) => k !== key && x.watchers === 0);
      idle.sort((a, b) => a[1].used - b[1].used);
      while (this.runners.size > MAX_RUNNER_CLIENTS && idle.length > 0) {
        const [k, x] = idle.shift()!;
        this.runners.delete(k);
        void x.sync.close();
      }
    }
    r.used = ++this.clock;
    return r;
  }

  async runFunction(path: string, args: Record<string, Value>, o?: RunOptions): Promise<FunctionRun> {
    const fn = await this.check(path, o?.identity, o?.signal);
    const { sync } = this.runner(o?.identity);
    const started = performance.now();
    const a = clientArgs(args);
    const r =
      fn.kind === "query"
        ? await sync.result(path, a, o?.signal)
        : fn.kind === "mutation"
          ? await sync.client.mutationInternal(path, a)
          : await sync.client.actionInternal(path, a);
    return runOf(r, Math.round(performance.now() - started));
  }

  watchFunction(
    path: string,
    args: Record<string, Value>,
    onResult: (run: FunctionRun) => void,
    onError: (error: DataSourceError) => void,
    o?: Pick<RunOptions, "identity">,
  ): Unsubscribe {
    let live = true;
    let off = () => {};
    const fail = (e: unknown) =>
      live && onError(e instanceof DataSourceError ? e : new DataSourceError("unavailable", String(e)));
    this.check(path, o?.identity).then((fn) => {
      if (!live) return;
      if (fn.kind !== "query")
        return fail(new DataSourceError("invalid_request", `${path} is a ${fn.kind}: only a query is subscribed.`));
      const runner = this.runner(o?.identity);
      runner.watchers += 1;
      // the first result's wait is its duration; an update was not requested, so it has none
      let since = performance.now();
      const stop = runner.sync.watch(path, clientArgs(args), (r) => {
        if (!live) return;
        onResult(runOf(r, Math.round(performance.now() - since)));
        since = performance.now();
      });
      off = () => {
        stop();
        runner.watchers -= 1;
      };
    }, fail);
    return () => {
      live = false;
      off();
    };
  }

  /**
   * Convex's `useRunTestFunction`: the module's code after the builders' import, run with no arguments; a 4xx is
   * the run's error (Convex shows its message), a refused key and a server failure reject.
   */
  async runTestQuery(code: string, o?: CallOptions): Promise<FunctionRun> {
    const caps = await this.capabilities();
    if (!caps.operations.includes("runFunctions"))
      throw new DataSourceError("unauthorized", "This credential cannot run test queries.");
    const started = performance.now();
    const res = await this.http.unauthenticated("/api/run_test_function", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bundle: { path: "testQuery.js", source: TEST_QUERY_PREAMBLE + code },
        adminKey: this.opts.adminKey,
        args: {},
        format: "encoded_json",
      }),
      ...(o?.signal && { signal: o.signal }),
    });
    const durationMs = () => Math.round(performance.now() - started);
    const body = (await res.json().catch(() => null)) as {
      status?: string;
      value?: Value;
      errorMessage?: string;
      errorData?: Value;
      logLines?: string[];
      message?: string;
    } | null;
    if (!res.ok) {
      const message = typeof body?.message === "string" ? body.message : `${res.status} ${res.statusText}`;
      const code = codeOfStatus(res.status);
      if (code === "invalid_request" || code === "not_found")
        return { error: { message }, logLines: [], durationMs: durationMs() };
      throw new DataSourceError(code, message);
    }
    const logLines = (body?.logLines ?? []).map(runLogLine);
    if (body?.status === "success") return { value: body.value ?? null, logLines, durationMs: durationMs() };
    return {
      error: {
        message: body?.errorMessage ?? "The test query failed.",
        ...(body?.errorData !== undefined && { data: body.errorData }),
      },
      logLines,
      durationMs: durationMs(),
    };
  }

  close(): Promise<void> {
    this.group.close();
    const runners = [...this.runners.values()];
    this.runners.clear();
    return Promise.all(runners.map((r) => r.sync.close())).then(() => {});
  }
}
