// The function runtime: query / mutation / action definitions (a handler, or `{ args, returns, handler }`
// with validators, as Convex — STUDY-13), the registry that names them ("module:fn"), internal functions,
// and the calls the transports make. Transactions themselves run in
// the engine (@bunvex/core); this layer only decides WHICH body runs and with what context.
import type { UserIdentity } from "@bunvex/auth";
import {
  type Caller,
  type CallRequest,
  checkEnvVarName,
  directFetch,
  type Engine,
  failExecution,
  formatBytes,
  IndexesUnavailableError,
  isQueryObject,
  newUserTimer,
  notRunningMessage,
  OccError,
  observeTime,
  opaqueToInspect,
  outsideExecution,
  pausingUserTime,
  type SessionRequestId,
  type SessionRequestOutcome,
  setFetchMeter,
  setFetchSender,
  stringifyValue,
  TableReader,
  type Tx,
  type UserTimer,
  userTimeMs,
  wallClock,
  withUserTimer,
} from "@bunvex/core";
import { type AnyFunctionReference, getFunctionName } from "@bunvex/protocol";
import {
  BunvexError,
  checkValue,
  copyValue,
  displayValue,
  type GenericValidator,
  hasCommitTs,
  isBunvexError,
  isSimpleObject,
  rawValueSize,
  toJsonValue,
  type Value,
  v,
} from "@bunvex/values";
import { isolateFetch, nodeFetch } from "./action-fetch.ts";

/**
 * A nested call's result as its caller gets it: Convex's crosses a JSON boundary (`runUdf` and the action
 * calls return `jsonToConvex` of the callee's `convexToJson(result === undefined ? null : result)`), so it is
 * a copy, `undefined` is `null`, `undefined` fields are gone and object fields come sorted (`copyValue`: the
 * same as that round trip, without building the JSON).
 */
const acrossCall = (value: unknown): Value => copyValue((value === undefined ? null : value) as Value);

import {
  ActionPermits,
  type ConcurrencyLimiter,
  type FunctionLimits,
  functionLimitsFromEnv,
} from "./action-permits.ts";
import {
  actionTimeoutError,
  checkActionAlive,
  cutOffWithAction,
  NODE_ACTION_USER_TIMEOUT_MS,
  nodeActionTimeoutError,
  V8_ACTION_USER_TIMEOUT_MS,
  withActionTimeout,
} from "./action-timeout.ts";
import {
  type AdminKeyIdentity,
  allows,
  BadDeployKeyError,
  type DeploymentOp,
  OperationNotPermittedError,
} from "./admin-keys.ts";
import type { AppMetrics } from "./app-metrics.ts";
import { type AnyArgs, exportedValidator, type FunctionDef, NODE_FUNCTIONS, type ValidatorExport } from "./builders.ts";
import { readCanonicalUrls, withCanonical } from "./canonical-urls.ts";
import { type EnvReader, withAllEnv, withEnv } from "./env-scope.ts";
import { describeUncaught, FunctionPathError, isSystemError, newRequestId, ValidatorError } from "./errors.ts";
import { canonicalPath, functionNameOf, inHandleScope } from "./function-handles.ts";
import {
  type CallerName,
  type Completion,
  type FunctionLog,
  type IdentityType,
  NO_USAGE,
  Running,
  type UdfType,
  usageStats,
} from "./function-log.ts";
import { HTTP_ACTION_RESPONSE_LIMIT, meteredBody } from "./http-body.ts";
import { type HttpProxy, proxiedFetch } from "./http-proxy.ts";
import { actionWarnings, functionWarnings, httpActionWarnings } from "./limit-warnings.ts";
import { collectingAuditLines, resolveAuditLines } from "./log-audit.ts";
import { type FunctionSource, type LogEvent, type RunReason, stackFrames } from "./log-events.ts";
import type { LogManager } from "./log-sinks.ts";
import {
  cachedQueryLogs,
  currentLogLines,
  currentOwner,
  currentOwnLines,
  type LogLine,
  logSystemLine,
  perAttempt,
  withOwner,
} from "./logs.ts";
import type { GenericActionCtx, GenericMutationCtx, GenericQueryCtx, VectorSearchQuery } from "./registration.ts";
import { makeScheduler, type Scheduler } from "./scheduler.ts";
import type { FileStorage, StorageMeter } from "./storage.ts";
import { SYSTEM_MUTATIONS, SYSTEM_QUERIES, type SystemQuery } from "./system-functions.ts";
import { ISOLATE_MEMORY_MB, NODE_MEMORY_MB, type UsageMeter } from "./usage-limits.ts";

/** The query cache key: function name + the args' canonical Convex JSON (fields sorted, bigint safe), and the
 *  hash of the code it ran (a code version's module, STUDY-35), so a new version never reads an old result. */
const cacheKeyOf = (hash: string, name: string, args: unknown) =>
  `${hash}\u0000${name}\u0000${stringifyValue(args ?? {})}`;

/** A function name as the registry keys it: `module:function`, `.js` stripped, `default` when unnamed. */
const registryKey = (name: string) => {
  const i = name.lastIndexOf(":");
  const [module, fn] = i === -1 ? [name, "default"] : [name.slice(0, i), name.slice(i + 1)];
  return `${module.endsWith(".js") ? module.slice(0, -3) : module}:${fn}`;
};

/**
 * An index still being rebuilt after a start (STUDY-79), as an action sees it: Convex rejects the action's
 * syscall promise with a plain `Error` carrying the message, which the action may catch.
 */
const unavailableToAction = (e: unknown) => (e instanceof IndexesUnavailableError ? new Error(e.message) : e);
const unavailableAsError = <T>(p: Promise<T>): Promise<T> =>
  p.catch((e) => {
    throw unavailableToAction(e);
  });

/**
 * How a mutation run by the function runner commits (STUDY-78): it checks the write throughput limit first,
 * as each of Convex's `run_mutation_no_udf_log` attempts does. Mutations a function calls inside its own
 * transaction do not: they are part of it.
 */
export const THROTTLED = { throttled: true } as const;

/** A duration knob in seconds from the environment (Convex's `env_config`), in ms; else `fallbackMs`. */
function secondsKnob(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallbackMs;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name}: not a positive number of seconds: ${raw}`);
  return n * 1000;
}

/** Convex's `MAX_REACTOR_CALL_DEPTH`: nested `runQuery` / `runMutation` levels below the top function. */
export const MAX_NESTED_CALL_DEPTH = 8;

/** The options of a nested `ctx.runQuery` / `ctx.runMutation` (Convex's `AdvancedRunQueryOptions`). */
export type NestedOptions = {
  useStaleSnapshot?: boolean;
  transactionLimits?: {
    bytesRead?: number;
    bytesWritten?: number;
    documentsRead?: number;
    documentsWritten?: number;
    databaseQueries?: number;
    functionsScheduled?: number;
    scheduledFunctionArgsBytes?: number;
  };
};

/**
 * A nested function's error as its caller sees it (Convex's `run_udf` and `performAsyncSyscall`): a
 * `BunvexError` with the data; else a new `Error` whose message is the nested `JsError`'s display — the
 * uncaught line and the nested stack frames (STUDY-41 N2), or for a timeout its message alone.
 */
function toCallerError(e: unknown, timer: UserTimer): Error {
  if (isBunvexError(e)) return new BunvexError(e.data);
  if (e === timer.failed) return new Error(`${(e as Error).message}\n`);
  return new Error(describeUncaught(e).message);
}

/**
 * A nested call's error for its caller, with the frames of the caller's call (`site`) instead of the server's
 * own, as Convex's: the error is the caller's, raised where it called (STUDY-95). A system error stays as it
 * is (it ends the request).
 */
function atCallSite(e: unknown, site: Error): unknown {
  if (!(e instanceof Error) || isSystemError(e as unknown)) return e;
  const err = e as Error;
  const frames = (site.stack ?? "").split("\n").filter((l) => /^\s+at /.test(l));
  err.stack = [err.message ? `${err.name}: ${err.message}` : err.name, ...frames].join("\n");
  return err;
}

/** `ctx.storage` (STUDY-32): what each context gets of `FileStorage`. */
export type StorageReader = ReturnType<FileStorage["reader"]>;
export type StorageWriter = ReturnType<FileStorage["writer"]>;
export type StorageActionWriter = ReturnType<FileStorage["actionWriter"]>;

/** `ctx.storage` without a configured file storage: every call says so. */
const noStorage = new Proxy(
  {},
  {
    get: () => async () => {
      throw new Error("File storage is not configured on this server.");
    },
  },
) as never;

/** `ctx.auth` (STUDY-27): the caller's identity, or null without a (valid) token. */
export type Auth = { getUserIdentity(): Promise<UserIdentity | null> };
/** The contexts of functions without a data model (`query`, `queryGeneric`, …): any table, any document. */
// biome-ignore lint/suspicious/noExplicitAny: Convex's builders without a data model take `any`
export type QueryCtx = GenericQueryCtx<any>;
// biome-ignore lint/suspicious/noExplicitAny: as above
export type MutationCtx = GenericMutationCtx<any>;
// biome-ignore lint/suspicious/noExplicitAny: as above
export type ActionCtx = GenericActionCtx<any>;
/** A function to call from an action: a reference (`api.module.fn`, `internal.module.fn`) or its name. */
export type FunctionRef = AnyFunctionReference | string;

/** What an HTTP action's `ctx.meta` names it: Convex runs it as `http.js:default`, stripped `http`. */
const HTTP_ACTION = { kind: "action", visibility: "public", handler: () => undefined } as unknown as FunctionDef;

/** A call that came with no request (a test, an embedded call): a fresh request id, nothing else. */
const REQUESTLESS = (): CallRequest => ({
  ip: null,
  userAgent: null,
  requestId: newRequestId(),
  authToken: null,
  scheduledFunctionId: null,
});

/** Who calls (STUDY-27): the identity, and its canonical JSON for the query cache's per-user entries. */
export const callerOf = (identity: UserIdentity | null): Caller =>
  identity === null ? { identity: null, key: "" } : { identity, key: stringifyValue(identity) };

/**
 * A caller with an admin key (STUDY-34): the admin (or system) identity, and the user it acts as, if any.
 * An admin is anonymous to `getUserIdentity()` (Convex: `user_identity()` is only a user's or an acting
 * user's), and an acting user is cached as that user.
 */
export type AdminCaller = Caller & { admin?: AdminKeyIdentity };
export const adminCallerOf = (admin: AdminKeyIdentity, actingAs: Record<string, unknown> | null): AdminCaller => ({
  identity: actingAs,
  // Its own key per kind of access, so a run one caller may see is never handed to a caller who may not
  // (the query cache's per-caller entries, sync's shared runs). Convex keys an admin by its operations too.
  key: `admin:${admin.kind}:${admin.kind === "admin" && admin.readOnly ? "ro" : "rw"}:${actingAs ? stringifyValue(actingAs as never) : ""}`,
  admin,
});
const adminOf = (caller: Caller | undefined) => (caller as AdminCaller | undefined)?.admin;
const INTERNAL_OPS = {
  query: "RunInternalQueries",
  mutation: "RunInternalMutations",
  action: "RunInternalActions",
} as const satisfies Record<string, DeploymentOp>;
const isSystemPath = (name: string) => name.startsWith("_system/");
const notFound = (name: string) =>
  new FunctionPathError(`Could not find public function for '${name.replace(/:default$/, "")}'.`);
const copy = <T>(x: T): T => (x === null ? x : structuredClone(x));
/** A transaction's `ctx.auth`: reading the identity marks the result as the caller's (the query cache). */
const txAuth = (db: Tx): Auth => ({
  getUserIdentity: async () => copy(db.readIdentity() as UserIdentity | null),
});

// The builders live in ./builders.ts (isomorphic); re-exported here for the runtime's own imports.
export {
  type ArgsOf,
  type ArgsValidator,
  action,
  actionGeneric,
  type FunctionDef,
  internalAction,
  internalActionGeneric,
  internalMutation,
  internalMutationGeneric,
  internalQuery,
  internalQueryGeneric,
  isFunctionDef,
  mutation,
  mutationGeneric,
  NODE_FUNCTIONS,
  query,
  queryGeneric,
  type Visibility,
} from "./builders.ts";

/**
 * Convex's `validateReturnValue` (registration_impl.ts, STUDY-66 §3): a query or mutation that returns a query
 * object, not its results, fails before its result is validated.
 */
async function notAQuery(result: unknown): Promise<unknown> {
  const value = await result;
  if (isQueryObject(value))
    throw new Error(
      "Return value is a Query. Results must be retrieved with `.collect()`, `.take(n), `.unique()`, or `.first()`.",
    );
  return value;
}

/** What a query's `db` leaves out: writing, and `vars` (Convex gives a query a reader). */
const WRITER_ONLY = new Set(["insert", "patch", "replace", "delete", "vars"]);
/**
 * A query run inside a mutation's transaction (`ctx.runQuery`) sees it as a reader, as Convex's: no writes
 * and no `db.vars` (STUDY-53, DV-267).
 */
function readerView(db: Tx): Tx {
  return new Proxy(db, {
    get(target, prop) {
      if (typeof prop === "string" && WRITER_ONLY.has(prop)) return undefined;
      // `db.table(name)` gives a reader too (STUDY-66 §2).
      if (prop === "table") return (name: string) => new TableReader(target, name);
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A function's path as the function log names it (Convex's stripped `UdfPath`): no `.js`, no `:default`. */
/** Convex's `FunctionRunReason` from the caller (a subscription's query reads as its first run). */
function runReason(caller: CallerName, udfType: UdfType): RunReason {
  switch (caller) {
    case "SyncWorker":
      return udfType === "Query" ? "initialSubscription" : "webSocket";
    case "HttpApi":
      return "httpApi";
    case "HttpEndpoint":
      return "httpEndpoint";
    case "Cron":
      return "cron";
    case "Scheduler":
      return "scheduler";
    case "Action":
      return "action";
    case "Tester":
      return "tester";
  }
}

const strippedPath = (name: string) => name.replace(/\.js(?=:|$)/, "").replace(/:default$/, "");

/** The transaction the current logged execution runs in, for its usage. */
function noteTx(db: Tx) {
  const owner = currentOwner();
  if (owner) owner.tx = db;
}

/** The running action a storage call or `fetch` is charged to (STUDY-71); a Node action's fetch is not. */
function meteredAction(): Running | null {
  const r = currentOwner();
  return r instanceof Running && (r.udfType === "Action" || r.udfType === "HttpAction") ? r : null;
}

const storageMeter: StorageMeter = ({ read, written }) => {
  const r = meteredAction();
  if (!r) return;
  r.io.storageCalls++;
  r.io.storageReadBytes += read ?? 0;
  r.io.storageWriteBytes += written ?? 0;
};

// An action's `fetch` reaches what Convex's runtime lets it reach (STUDY-80): http(s) only, without Bun's
// options, and an isolate action's through its deployment's proxy (`Functions.httpProxy`).
const nodeSender = nodeFetch();
setFetchSender(() => meteredAction()?.send ?? null);

// Convex meters an isolate action's fetch request bodies; a Node action's egress is its Lambda's network
// counter, 0 when self-hosted (STUDY-71 U2).
setFetchMeter(() => {
  const r = meteredAction();
  if (!r || r.environment !== "isolate") return null;
  // Pending until it settles (an action's unawaited operations, STUDY-76); charged once it went out.
  const settle = pendingOp(r, "fetch");
  return (bytes) => {
    settle();
    if (bytes !== null) r.io.networkEgressBytes += bytes;
  };
});

/** Count an operation of `r` as pending until the returned function is called (Convex's dangling tasks). */
function pendingOp(r: Running, name: string): () => void {
  r.pendingOps.set(name, (r.pendingOps.get(name) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    r.pendingOps.set(name, (r.pendingOps.get(name) ?? 1) - 1);
  };
}

/** `fn`'s promise, pending under `name` for the running action until it settles. */
function tracked<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const r = meteredAction();
  if (!r) return fn();
  const settle = pendingOp(r, name);
  return fn().finally(settle);
}

/**
 * An action's context whose operations count as pending until they settle, under Convex's names for them
 * (its syscalls, `name_when_dangling`): the unawaited-operations warning lists those still pending when the
 * action returns (STUDY-76).
 */
function trackedCtx(ctx: ActionCtx): ActionCtx {
  // biome-ignore lint/suspicious/noExplicitAny: wraps methods of every signature
  const wrap = <F extends (...a: any[]) => any>(name: string, fn: F | undefined): F =>
    (fn === undefined ? fn : (...a: Parameters<F>) => tracked(name, async () => fn(...a))) as F;
  const c = ctx as unknown as Record<string, any>;
  const s = c.scheduler;
  const st = c.storage;
  return {
    ...c,
    auth: { ...c.auth, getUserIdentity: wrap("getUserIdentity", c.auth.getUserIdentity) },
    runQuery: wrap("query", c.runQuery),
    runMutation: wrap("mutation", c.runMutation),
    runAction: wrap("action", c.runAction),
    scheduler: {
      ...s,
      runAfter: wrap("schedule", s.runAfter?.bind(s)),
      runAt: wrap("schedule", s.runAt?.bind(s)),
      cancel: wrap("cancel_job", s.cancel?.bind(s)),
    },
    storage: {
      ...st,
      getUrl: wrap("storageGetUrl", st.getUrl),
      getMetadata: wrap("storageGetMetadata", st.getMetadata),
      generateUploadUrl: wrap("storageGenerateUploadUrl", st.generateUploadUrl),
      delete: wrap("storageDelete", st.delete),
      store: wrap("storage.store", st.store),
      get: wrap("storage.get", st.get),
    },
    vectorSearch: wrap("vectorSearch", c.vectorSearch),
  } as unknown as ActionCtx;
}

/** A query's or mutation's timer, for the log's user execution time (STUDY-71). */
function timed(timer: UserTimer): UserTimer {
  const owner = currentOwner();
  if (owner) owner.timer = timer;
  return timer;
}

/** Convex's `FUNCTION_MAX_ARGS_SIZE` and `FUNCTION_MAX_RESULT_SIZE` defaults: 16 MiB. */
export const FUNCTION_MAX_ARGS_SIZE = 1 << 24;
export const FUNCTION_MAX_RESULT_SIZE = 1 << 24;

/** A size limit from the environment (a non-negative integer of bytes), else Convex's default. */
function sizeKnob(name: string, def: number, env: Record<string, string | undefined> = process.env): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name}: not a non-negative integer: ${raw}`);
  return n;
}

/** A successful result's size (Convex's `return_bytes`; bunvex counts it as for limits, DV-274). */
const returned = (value: unknown): Outcome => ({ returnBytes: sizeOfResult(value) });

/**
 * Results' sizes as `checkReturns` measured them, so the function log does not walk a large result twice
 * (an object or array is measured once; the size of a 1 MiB result is a few ms).
 */
const resultSizes = new WeakMap<object, number>();
function sizeOfResult(value: unknown): number {
  if (typeof value === "object" && value !== null) {
    const known = resultSizes.get(value);
    if (known !== undefined) return known;
  }
  return rawValueSize((value ?? null) as Value);
}
/** The same for a result already as JSON: its length. */
const returnedJson = (json: string): Outcome => ({ returnBytes: json.length });

/** A caller with who runs the call, for the function log (STUDY-47); `HttpApi` when unset. */
export type SourcedCaller = Caller & {
  source?: CallerName;
  /** A sync query's reason to run (Convex's `QueryInvocation`): its first run, a data or an identity change. */
  runReason?: RunReason;
  /** A WebSocket mutation's queue: the mutations waiting before it when it arrived (Convex's). */
  mutationQueueLength?: number;
  /**
   * The failed attempts of the job this run belongs to, counted across its loop's runs (a scheduled or cron
   * mutation retried after an OCC conflict escaped the engine's retries): Convex counts every attempt.
   */
  retries?: { n: number };
  /** Its caller runs it again when it loses an OCC conflict (the scheduler's and crons' loops): `willRetry`. */
  retriesOcc?: boolean;
};

/** Convex's `function_args_bytes`: the length of the arguments' JSON array, as the client sent it. */
const argsBytesOf = (args: unknown) => JSON.stringify([toJsonValue((args ?? {}) as Value)]).length;

/** What a logged execution's result tells the log. `skip`: nothing ran (a replayed session request). */
type Outcome = { returnBytes?: number | null; success?: { status: string } | null; error?: unknown; skip?: boolean };

/** Convex's `Identity::tag()` for a caller: scheduled and cron runs are `unknown`, as anonymous calls. */
function identityTypeOf(caller: Caller | undefined): IdentityType {
  if ((caller as AdminCaller | undefined)?.admin) return caller!.identity ? "member_acting_user" : "instance_admin";
  return caller?.identity ? "user" : "unknown";
}

/**
 * An HTTP action's client went away before the response head could be sent: Convex's
 * `ErrorMetadata::client_disconnect` ("Client disconnected"), which its function log records as the result.
 */
class ClientDisconnectedError extends Error {
  constructor() {
    super("Client disconnected");
  }
}

/** An error as the log shows it: a function's as Convex's `JsError` display, the server's own as its message. */
const errorText = (e: unknown) =>
  e instanceof OccError || isSystemError(e) || e instanceof ClientDisconnectedError
    ? (e as Error).message
    : describeUncaught(e).message;

/** Convex's vector filter builder: `q.eq(field, value)` and `q.or(...)`, as the expression JSON it sends. */
const VECTOR_FILTER_BUILDER = {
  eq(field: unknown, value: unknown) {
    if (typeof field !== "string") throw new Error("The first argument to `q.eq` must be a field name.");
    return { $eq: [{ $field: field }, { $literal: value }] };
  },
  or(...exprs: unknown[]) {
    return { $or: exprs };
  },
};

export class Functions {
  private fns = new Map<string, FunctionDef>();
  /** Each function's name as its key (`module:fn`), for `ctx.meta.getFunctionMetadata()`. */
  private names = new WeakMap<FunctionDef, string>();
  /** Each module's code hash (a deployed code version's modules); empty for registered (embedded) code. */
  private moduleHashes = new Map<string, string>();

  /** A function name's module, as the registry and code versions key it (`dir/file` of `dir/file:fn`). */
  static moduleOf(name: string) {
    const key = registryKey(name);
    return key.slice(0, key.lastIndexOf(":"));
  }

  private cacheKey(name: string, args: unknown) {
    return cacheKeyOf(this.moduleHashes.get(Functions.moduleOf(name)) ?? "", name, args);
  }

  /**
   * Replace every function at once with a code version's (STUDY-35): the next call of any name runs the new
   * code. The modules whose code changed (added, removed or a new hash), for re-running what read them.
   */
  install(fns: Map<string, FunctionDef>, moduleHashes: Map<string, string>): Set<string> {
    const changed = new Set<string>();
    for (const [m, h] of moduleHashes) if (this.moduleHashes.get(m) !== h) changed.add(m);
    for (const m of this.moduleHashes.keys()) if (!moduleHashes.has(m)) changed.add(m);
    for (const k of this.fns.keys()) if (!fns.has(k)) changed.add(Functions.moduleOf(k));
    for (const k of fns.keys()) if (!this.fns.has(k)) changed.add(Functions.moduleOf(k));
    this.fns = new Map(fns);
    this.moduleHashes = new Map(moduleHashes);
    this.deployed = true;
    return changed;
  }

  /** Whether the functions are pushed code, which sees the deployment's variables (STUDY-37 E3). */
  private deployed = false;
  /** The built-in variables (the server's origins), read after the deployment's (which cannot hold them). */
  builtinEnv: Record<string, string> = {};
  /** The HTTP routes served (method, path), for `apiSpec`; the server sets it. */
  httpRoutes: () => readonly (readonly [string, string])[] = () => [];

  /** A query's or mutation's `process.env`: each read in `db`'s read set. */
  private async txEnv(db: Tx): Promise<EnvReader | null> {
    if (!this.deployed) return null;
    const read = await this.engine.environment.reader(db);
    // The canonical URLs in place of the origins (STUDY-49), read here so a change re-runs what read them.
    const builtin = withCanonical(this.builtinEnv, await readCanonicalUrls(db));
    return (name) => read(name) ?? builtin[name];
  }

  /** An action's `process.env`: the variables at its start (Convex's `get_all`, no reactivity). */
  private async actionEnv(): Promise<{ all: Record<string, string>; read: EnvReader } | null> {
    if (!this.deployed) return null;
    const [vars, canonical] = await this.engine.query(
      async (db) => [await this.engine.environment.snapshot(db), await readCanonicalUrls(db)] as const,
    );
    const all = { ...withCanonical(this.builtinEnv, canonical), ...Object.fromEntries(vars) };
    return {
      all,
      read: (name) => {
        checkEnvVarName(name);
        return all[name];
      },
    };
  }

  /** Run `fn` under an action's environment. */
  private async inActionEnv<T>(fn: () => T | Promise<T>): Promise<T> {
    const env = await this.actionEnv();
    return env ? withAllEnv(env.all, env.read, fn) : fn();
  }

  /**
   * The audit log's retention in days (STUDY-48), as Convex's `_backend_info.auditLogRetentionDays`: -1
   * keeps everything, null means no audit log access. Set by `createServer`.
   */
  auditLogRetentionDays: number | null = -1;

  /** The function execution log (STUDY-47); set by `createServer`. */
  functionLog: FunctionLog | null = null;

  /**
   * @internal Run one execution of `name` and log it (STUDY-47): a Completion when it ends, and for an
   * action or HTTP action each line as a Progress event as it is printed. A function an action calls is
   * logged with the action as its parent, in its request. System functions are not logged, as in Convex.
   */
  async logged<T>(
    udfType: UdfType,
    name: string,
    caller: Caller | undefined,
    run: () => Promise<T>,
    outcome?: (value: T) => Outcome,
    /** An HTTP action's route path, its name in the app metrics. */
    routePath?: string,
    /** The arguments, for `function_args_bytes` (none for an HTTP action, as Convex's). */
    args?: unknown,
    /**
     * An HTTP action's run is logged once its response's body is sent, as Convex's (STUDY-76, DV-323):
     * `settled` gives the work to do then (in the run's log context), when it resolves.
     */
    settled?: (value: T) => Promise<() => void> | null,
  ): Promise<T> {
    const log = this.functionLog;
    // System functions are not logged, as in Convex, but their compute and bandwidth are metered.
    const system = isSystemPath(name);
    if (!log || (system && !this.usageMeter)) return run();
    const up = currentOwner();
    const parent = up instanceof Running ? up : null;
    const r = new Running(
      crypto.randomUUID(),
      parent?.requestId ?? caller?.request?.requestId ?? newRequestId(),
      parent,
      udfType,
      udfType === "HttpAction" ? name : strippedPath(name),
      parent ? "Action" : udfType === "HttpAction" ? "HttpEndpoint" : ((caller as SourcedCaller)?.source ?? "HttpApi"),
      identityTypeOf(caller),
      wallClock(),
      udfType === "Action" && this.isNodeAction(name) ? "node" : "isolate",
    );
    r.tokenIdentifier = ((caller?.identity as { tokenIdentifier?: unknown } | null)?.tokenIdentifier as string) ?? null;
    r.ip = caller?.request?.ip ?? null;
    if (!system && (udfType === "Action" || udfType === "HttpAction"))
      r.onLine = (line) => {
        log.append({
          kind: "Progress",
          udfType,
          identifier: r.identifier,
          timestamp: r.start / 1000,
          logLines: [line],
          requestId: r.requestId,
          executionId: r.executionId,
          root: parent === null,
        });
        // An action's lines stream out as they come (Convex's progress Console events).
        if (this.logManager?.active)
          this.logManager.send([
            { timestamp: line.timestamp, event: { topic: "console", source: this.eventSource(r, null), line } },
          ]);
      };
    r.metricsName = udfType === "HttpAction" ? (routePath ?? name) : this.metricsNameOf(r.identifier);
    const sourced = caller as SourcedCaller | undefined;
    r.runReason = sourced?.runReason ?? null;
    r.mutationQueueLength = sourced?.mutationQueueLength ?? null;
    r.retries = sourced?.retries ?? { n: 0 };
    r.send = r.environment === "isolate" ? this.isolateSender : nodeSender;
    if (sourced?.source === "Scheduler") r.schedulerJobId = caller?.request?.scheduledFunctionId ?? null;
    if (udfType !== "HttpAction") {
      try {
        r.argsBytes = argsBytesOf(args);
      } catch {
        r.argsBytes = null; // arguments that are no value fail the run anyway
      }
    }
    const res = await withOwner(r, run);
    const o: Outcome = res.ok ? (outcome?.(res.value) ?? {}) : { error: res.error };
    const retried = !res.ok && res.error instanceof OccError && sourced?.retriesOcc === true;
    const later = res.ok && !o.skip ? settled?.(res.value) : null;
    // Its lines end with it: an action cut off by its timeout (STUDY-77) logs nothing more, as Convex's
    // terminated isolate. An HTTP action's run ends once its body is sent (its lines until then still stream).
    if (!(res.ok && later)) r.onLine = null;
    if (res.ok && later) {
      // Logged when the body is sent: the lines written meanwhile join the run's.
      void later.then(async (after) => {
        const more = await withOwner(r, async () => after());
        r.onLine = null;
        const c = this.completion(r, [...res.lines, ...more.lines], o, false);
        if (system) this.meterCompletion(r, c, false);
        else this.logCompletion(log, r, c, o.error);
      });
      return res.value;
    }
    if (!o.skip) {
      const c = this.completion(r, res.lines, o, retried);
      if (system) this.meterCompletion(r, c, false);
      else this.logCompletion(log, r, c, o.error);
    }
    if (retried) r.retries.n++;
    if (!res.ok) throw res.error;
    return res.value;
  }

  private isNodeAction(name: string): boolean {
    const f = this.fns.get(registryKey(name)) ?? this.fns.get(name);
    return f !== undefined && NODE_FUNCTIONS.has(f);
  }

  /** The current mutation attempt lost an OCC conflict and runs again: log it (the engine's `onOccRetry`). */
  logOccRetry(error: OccError) {
    const r = currentOwner();
    if (this.functionLog && r instanceof Running) {
      this.logCompletion(this.functionLog, r, this.completion(r, currentOwnLines(), { error }, true), error);
      // The next attempt's `mutation_retry_count` (Convex's `backoff.failures()`).
      r.retries.n++;
    }
  }

  private metricsNames = new Map<string, string>();
  /** A function's canonical path, its app metrics name (cached: names come from code). */
  private metricsNameOf(identifier: string): string {
    let n = this.metricsNames.get(identifier);
    if (n === undefined) {
      if (this.metricsNames.size >= 10_000) this.metricsNames.clear();
      n = canonicalPath(identifier);
      this.metricsNames.set(identifier, n);
    }
    return n;
  }

  /** The app metrics (STUDY-58); set by `createServer`. */
  appMetrics: AppMetrics | null = null;
  /** Queries and mutations running now, for the metrics' `function_concurrency`. */

  /** Log a completion, and record it in the app metrics as Convex's `log_execution_app_metrics`. */
  /** Where an event of `r` comes from (Convex's `FunctionEventSource`). */
  private eventSource(r: Running, cached: boolean | null): FunctionSource {
    return {
      path: r.udfType === "HttpAction" ? r.identifier : this.metricsNameOf(r.identifier),
      udfType: r.udfType,
      cached,
      requestId: r.requestId,
      // Every mutation's, 0 on its first attempt (Convex's `backoff.failures()`); none for the rest.
      mutationRetryCount: r.udfType === "Mutation" ? r.retries.n : null,
      mutationQueueLength: r.udfType === "Mutation" ? r.mutationQueueLength : null,
    };
  }

  /** Running and queued executions per kind, for the log streams' `concurrency_stats`. */
  concurrency() {
    const l = this.limits;
    return {
      query: { ...l.query.outstanding },
      mutation: { ...l.mutation.outstanding },
      action: { ...l.action.outstanding },
      nodeAction: { ...l.nodeAction.outstanding },
      // HTTP actions share the action limiter, which reports as actions (Convex has no HTTP action gauge).
      httpAction: { running: 0, queued: 0 },
    };
  }

  /** Log streams (STUDY-59); set by `createServer`. */
  logManager: LogManager | null = null;

  /** Convex's events for a completion: its lines (not an action's, already sent), the execution, an exception. */
  private streamCompletion(r: Running, c: Completion, error: unknown) {
    const source = this.eventSource(r, c.udfType === "Query" ? c.cachedResult : null);
    const at = c.timestamp * 1000;
    const events: LogEvent[] = [];
    if (c.udfType !== "Action" && c.udfType !== "HttpAction")
      for (const line of c.logLines)
        events.push({ timestamp: line.timestamp, event: { topic: "console", source, line } });
    events.push({
      timestamp: at,
      event: {
        topic: "function_execution",
        source,
        error: c.error,
        executionTime: c.executionTime,
        userExecutionTime: c.userExecutionTime,
        usage: c.usageStats,
        argsBytes: r.argsBytes,
        returnBytes: c.returnBytes,
        occInfo: c.occInfo,
        willRetry: c.willRetry,
        schedulerJobId: r.schedulerJobId,
        runReason: (r.runReason as RunReason | null) ?? runReason(c.caller, c.udfType),
      },
    });
    if (c.error !== null) {
      // Convex's `Exception` event: the error's message, its frames, a `BunvexError`'s data (STUDY-70).
      const e = error instanceof Error ? error : null;
      let customData: unknown = null;
      if (isBunvexError(error))
        try {
          customData = toJsonValue((error as { data: Value }).data);
        } catch {}
      events.push({
        timestamp: at,
        event: {
          topic: "exception",
          source,
          message: e?.message ?? c.error,
          userIdentifier: r.tokenIdentifier,
          frames: stackFrames(e?.stack),
          customData,
          ip: r.ip,
          runtime: r.environment === "node" ? "node" : "default",
        },
      });
    }
    this.logManager!.send(events);
  }

  /** The usage meter (STUDY-61); set by `createServer`. */
  usageMeter: UsageMeter | null = null;
  /** An isolate action's `fetch`: through the operator's proxy when there is one (STUDY-80 §3.2). */
  private isolateSender = isolateFetch(proxiedFetch(directFetch, null, true));
  private proxy: HttpProxy | null = null;
  /** The proxy an isolate action's `fetch` goes through (Convex's `--convex-http-proxy`); null for none. */
  get httpProxy(): HttpProxy | null {
    return this.proxy;
  }
  set httpProxy(p: HttpProxy | null) {
    this.proxy = p;
    this.isolateSender = isolateFetch(proxiedFetch(directFetch, p, true));
  }

  /** A run's usage into the meter (STUDY-61, STUDY-71); `tracked`: whether the call counts (not `_system/`). */
  private meterCompletion(r: Running, c: Completion, tracked: boolean) {
    this.usageMeter?.recordExecution({
      udfType: c.udfType,
      environment: c.environment,
      executionTime: c.cachedResult ? 0 : c.executionTime,
      userExecutionTime: c.userExecutionTime,
      memoryMb: c.usageStats.memoryUsedMb,
      databaseIoBytes: c.usageStats.databaseIoReadBytes + c.usageStats.databaseIoWriteBytes,
      dataEgressBytes: r.io.networkEgressBytes + r.io.storageReadBytes,
      searchQueryBytes: c.usageStats.textIndexQueryBytes + c.usageStats.vectorIndexReadQueryBytes,
      storageCalls: r.io.storageCalls,
      tracked,
    });
  }

  private logCompletion(log: FunctionLog, r: Running, c: Completion, error?: unknown) {
    log.append(c);
    if (this.logManager?.active) this.streamCompletion(r, c, error);
    this.appMetrics?.recordExecution({
      udfType: c.udfType,
      name: r.metricsName,
      at: c.timestamp * 1000,
      failed: c.error !== null,
      cached: c.cachedResult,
      executionTime: c.executionTime,
      ...(r.tx ? { tables: (r.tx as Tx).tableStats } : {}),
    });
    this.meterCompletion(r, c, true);
  }

  private completion(r: Running, lines: LogLine[], o: Outcome, willRetry: boolean): Completion {
    const end = wallClock();
    const e = o.error;
    // A mutation's writes count once it committed (Convex meters them in `track_commit`).
    const used = (r.tx as Tx | null)?.io(r.udfType === "Mutation" && e === undefined);
    const seconds = (end - r.start) / 1000;
    return {
      kind: "Completion",
      udfType: r.udfType,
      identifier: r.identifier,
      logLines: lines,
      timestamp: end / 1000,
      cachedResult: r.cached,
      caller: r.caller,
      parentExecutionId: r.parent?.executionId ?? null,
      executionTime: seconds,
      // A query's or mutation's user time excludes its store and nested calls, as Convex's; an action's is its
      // wall time, as Convex pauses an action's clock only while its isolate starts (STUDY-71).
      // Never above the wall time, which bunvex reads from a coarser clock.
      userExecutionTime: r.timer ? Math.min(userTimeMs(r.timer as UserTimer) / 1000, seconds) : seconds,
      success: e === undefined ? (o.success ?? null) : null,
      // An attempt that lost an OCC conflict and runs again has no error, as Convex logs it before it fails
      // the outcome (only `occInfo` and `willRetry` tell it apart; STUDY-74).
      error: e === undefined || (willRetry && e instanceof OccError) ? null : errorText(e),
      requestId: r.requestId,
      executionId: r.executionId,
      usageStats: {
        ...(used ? usageStats(used) : NO_USAGE),
        storageReadBytes: r.io.storageReadBytes,
        storageWriteBytes: r.io.storageWriteBytes,
        networkEgressBytes: r.io.networkEgressBytes,
        // An action's vector searches (a transaction has none): Convex's v1 database egress includes their
        // results, its v2 (`databaseIo*`) does not.
        vectorIndexReadQueryBytes: r.io.vectorQueryBytes,
        vectorIndexReadBytes: r.io.vectorReadBytes,
        ...(r.io.vectorReadBytes > 0 && {
          databaseReadBytes: (used?.readBytes ?? 0) + r.io.vectorReadBytes,
        }),
        // Convex's memory per execution: its isolate heap (64 MiB), a Node action's 512 MB; none for a
        // cached query (STUDY-61).
        memoryUsedMb: r.cached ? 0 : r.environment === "node" ? NODE_MEMORY_MB : ISOLATE_MEMORY_MB,
      },
      returnBytes:
        e === undefined
          ? (o.returnBytes ?? null)
          : willRetry && e instanceof OccError && e.attempt
            ? sizeOfResult(e.attempt.value ?? null)
            : null,
      occInfo:
        e instanceof OccError
          ? {
              tableName: e.info.table ?? null,
              documentId: e.info.documentId ?? null,
              writeSource: e.info.writeSource ?? null,
              componentPath: null,
              retryCount: e.info.retries,
            }
          : null,
      willRetry,
      executionTimestamp: r.start / 1000,
      identityType: r.identityType,
      environment: r.environment,
    };
  }

  /** Where files go (STUDY-32); set by `createServer`. */
  fileStorage: FileStorage | null = null;

  /** How many actions run at once (STUDY-31): every action, HTTP actions included, takes a permit. */
  /** How many functions of each kind run at once (STUDY-68). */
  readonly limits: FunctionLimits;
  /** The action limiter (STUDY-31), `limits.action`. */
  readonly actionPermits: ConcurrencyLimiter;

  constructor(
    private engine: Engine,
    opts: { actionPermits?: ConcurrencyLimiter; limits?: FunctionLimits } = {},
  ) {
    this.limits = opts.limits ?? functionLimitsFromEnv(process.env, opts.actionPermits ?? ActionPermits.fromEnv());
    this.actionPermits = this.limits.action;
  }

  register(module: string, fns: Record<string, FunctionDef>) {
    for (const [n, f] of Object.entries(fns)) this.fns.set(`${module}:${n}`, f);
    return this;
  }

  /**
   * Convex's `require_operation`: the system may do anything, an admin what its key allows
   * (`OperationNotPermitted`); anyone else is told the deploy key is invalid (`BadDeployKey`).
   */
  requireOperation(caller: Caller | undefined, op: DeploymentOp) {
    const admin = adminOf(caller);
    if (!admin) throw new BadDeployKeyError(this.engine.instanceName || undefined);
    if (!allows(admin, op)) throw new OperationNotPermittedError(op);
  }

  /**
   * Convex's `check_visibility_access` (crates/udf/src/validation.rs) for a client's call: acting as a user
   * needs `ActAsUser`; an internal function is open to an admin with `RunInternal*`, and missing to
   * everyone else.
   */
  private checkAccess(f: FunctionDef | undefined, name: string, kind: FunctionDef["kind"], caller?: Caller) {
    const admin = adminOf(caller);
    if (admin && caller?.identity != null) this.requireOperation(caller, "ActAsUser");
    if (!f) throw notFound(name);
    if (f.visibility === "internal") {
      if (!admin) throw notFound(name);
      this.requireOperation(caller, INTERNAL_OPS[kind]);
    }
  }

  private fn<K extends FunctionDef["kind"]>(name: string, kind: K, fromClient: boolean, caller?: Caller) {
    // `dir/file` is its default export, and `.js` is optional, as Convex canonicalizes a path.
    const key = this.fns.has(name) ? name : registryKey(name);
    const f = this.fns.get(key);
    if (f) this.names.set(f, key);
    // As Convex (crates/udf/src/validation.rs): a missing function and an internal one called from a
    // client read the same, with the path stripped (no `.js`, no `:default`); a function of another kind
    // names the canonical path (`module.js:name`) and both kinds.
    if (fromClient) this.checkAccess(f, name, kind, caller);
    else if (!f) throw notFound(name);
    if (!f) throw notFound(name);
    if (f.kind !== kind) {
      const i = name.lastIndexOf(":");
      const kindName = (k: string) => k[0].toUpperCase() + k.slice(1);
      throw new FunctionPathError(
        `Trying to execute ${name.slice(0, i)}.js${name.slice(i)} as ${kindName(kind)}, but it is defined as ${kindName(f.kind)}.`,
      );
    }
    return f as Extract<FunctionDef, { kind: K }>;
  }

  /**
   * A function's kind for Convex's `/api/function` (`execute_any_function`): what it runs as, or null when
   * it does not exist. System functions too.
   */
  kindOf(name: string): FunctionDef["kind"] | null {
    if (isSystemPath(name)) {
      const n = name.replace(/:default$/, "");
      return SYSTEM_QUERIES[n] ? "query" : SYSTEM_MUTATIONS[n] ? "mutation" : null;
    }
    return (this.fns.get(name) ?? this.fns.get(registryKey(name)))?.kind ?? null;
  }

  /** Whether a function is internal (false when it does not exist). */
  isInternal(name: string): boolean {
    return (this.fns.get(name) ?? this.fns.get(registryKey(name)))?.visibility === "internal";
  }

  /**
   * Convex's `_system/cli/modules:apiSpec`: every function, its kind, visibility and validators, then the
   * HTTP routes as `{ functionType: "HttpAction", method, path }`. The validators are what the function's
   * `exportArgs()` / `exportReturns()` give, as the push stored them: `{ type: "any" }` arguments and a `null`
   * result validator when the function declares none.
   */
  apiSpec() {
    const kind = { query: "Query", mutation: "Mutation", action: "Action" } as const;
    const routes = this.httpRoutes().map(([method, path]) => ({ functionType: "HttpAction", method, path }));
    const fns = [...this.fns].map(([key, f]) => {
      const i = key.lastIndexOf(":");
      const identifier = `${key.slice(0, i)}.js:${key.slice(i + 1)}`;
      const exported = (method: ValidatorExport) => {
        const r = exportedValidator(f, method, identifier);
        if ("problem" in r) throw new Error(r.problem);
        return JSON.parse(r.json) as Value;
      };
      return {
        identifier,
        functionType: kind[f.kind],
        visibility: { kind: f.visibility },
        args: exported("exportArgs"),
        returns: exported("exportReturns"),
      };
    });
    return [...fns, ...routes];
  }

  /** An id's table, for `v.id` (the engine's catalog). */
  private tableOf = (n: number) => this.engine.catalog.byNumber(n)?.name;

  /**
   * Convex's `FUNCTION_MAX_ARGS_SIZE` and `FUNCTION_MAX_RESULT_SIZE` (crates/common/src/knobs.rs, STUDY-64
   * §1.7): 16 MiB each, read from environment variables of the same names.
   */
  maxArgsSize = sizeKnob("FUNCTION_MAX_ARGS_SIZE", FUNCTION_MAX_ARGS_SIZE);
  maxResultSize = sizeKnob("FUNCTION_MAX_RESULT_SIZE", FUNCTION_MAX_RESULT_SIZE);

  /**
   * Arguments are an object, no larger than `maxArgsSize`, checked against `args` when the function declares
   * it (Convex's rules and order: `ValidatedPathAndArgs` in crates/udf/src/validation.rs).
   */
  private checkArgs(f: FunctionDef, args: unknown): AnyArgs {
    // Without a validator, Convex hands the handler whatever came (a number, null); with one, the single
    // argument must be an object (`check_args`).
    const a = args === undefined ? {} : args;
    if (f.args && !isSimpleObject(a))
      throw ValidatorError.args(
        `Expected to receive an object as the function's argument. Instead received: ${displayValue((a ?? null) as Value)}`,
      );
    // Convex measures the positional args array, `[args]` (`validate_udf_args_size`, crates/udf/src/helpers.rs).
    const size = rawValueSize([a as Value]);
    if (size > this.maxArgsSize)
      throw new FunctionPathError(
        `Arguments for ${this.pathOf(f)} are too large (actual: ${formatBytes(size)}, limit: ${formatBytes(this.maxArgsSize)})`,
      );
    if (f.args) {
      const msg = checkValue(f.args, a as Value, this.tableOf);
      if (msg) throw ValidatorError.args(msg);
    }
    return a as AnyArgs;
  }

  /**
   * The result: no larger than `maxResultSize` (Convex measures it as the run returns, in
   * `deserialize_udf_result`, crates/isolate/src/helpers.rs), then checked against `returns` when declared
   * (`undefined` is null, as in Convex). A failure is the function's error: a mutation writes nothing.
   */
  private checkReturns(f: FunctionDef, value: unknown) {
    const size = rawValueSize((value ?? null) as Value);
    if (typeof value === "object" && value !== null) resultSizes.set(value, size);
    if (size > this.maxResultSize)
      throw new FunctionPathError(
        `Function ${this.pathOf(f)} return value is too large (actual: ${formatBytes(size)}, limit: ${formatBytes(this.maxResultSize)})`,
      );
    if (f.returns) {
      const msg = checkValue(f.returns, (value ?? null) as Value, this.tableOf);
      if (msg) throw ValidatorError.returns(msg);
    }
    return value;
  }

  /** A function's canonical path for a limit message, as Convex prints `CanonicalizedUdfPath`: `module.js:fn`. */
  private pathOf(f: FunctionDef): string {
    return canonicalPath(this.names.get(f) ?? "");
  }

  /** The body a query runs, for the transports that manage their own transaction (subscriptions). */
  queryBody(name: string, args: unknown, fromClient = true, caller?: Caller) {
    const body = this.queryBodyOf(name, args, fromClient, caller);
    return async (db: Tx) => {
      const value = await body(db);
      // Convex's check: only a mutation's result may hold `db.vars.commitTs` (STUDY-53).
      if (hasCommitTs(value))
        throw new Error(`Function ${name} return value invalid: queries cannot return an unresolved commit timestamp`);
      return value;
    };
  }

  /**
   * Run a query's or mutation's body, then add Convex's approaching-limit warnings to its lines (STUDY-76):
   * when it returned or threw the app's error; a system failure ends it without them, as in Convex.
   */
  private async warned<T>(
    db: Tx,
    args: unknown,
    timer: UserTimer,
    body: () => Promise<T>,
    userLimitMs = timer.userMs,
  ): Promise<T> {
    const warnings = (resultBytes: number | null) =>
      functionWarnings({
        argsBytes: rawValueSize([args as Value]),
        maxArgsBytes: this.maxArgsSize,
        tx: db,
        resultBytes,
        maxResultBytes: this.maxResultSize,
        userMs: userTimeMs(timer),
        userLimitMs,
      });
    let value: T;
    try {
      value = await body();
    } catch (e) {
      if (!isSystemError(e)) warnings(null);
      throw e;
    }
    warnings(sizeOfResult(value ?? null));
    return value;
  }

  private queryBodyOf(name: string, args: unknown, fromClient = true, caller?: Caller) {
    if (isSystemPath(name)) return this.systemQueryBody(name, args, fromClient, caller);
    const resolved = this.fnLater(name, "query", fromClient, caller);
    return async (db: Tx) => {
      noteTx(db);
      await this.failWhileNotRunning(db);
      const f = resolved();
      const a = this.checkArgs(f, args);
      const env = await this.txEnv(db);
      // A permit for the run, once it is validated (STUDY-68); a cached result never gets here.
      return this.limits.query.run(async () => {
        const timer = timed(this.newTimer());
        const run = () => this.withAudit(db, () => withUserTimer(timer, () => this.invoke(f, db, a, 0)));
        return this.warned(db, a, timer, async () => this.checkReturns(f, await (env ? withEnv(env, run) : run())));
      });
    };
  }

  /**
   * The body a mutation runs: per attempt, so a retried run's console lines replace the aborted one's.
   * `job`: the scheduled job it runs as, if any (a mutation cannot cancel its own job).
   */
  private mutationBody(
    resolved: () => FunctionDef & { kind: "mutation" },
    args: unknown,
    job?: string,
    deadline?: Deadline,
  ) {
    return perAttempt(async (db: Tx) => {
      checkDeadline(deadline);
      noteTx(db);
      await this.failWhileNotRunning(db);
      const f = resolved();
      const a = this.checkArgs(f, args);
      const env = await this.txEnv(db);
      // A permit per attempt (STUDY-68), with the timeout even for a scheduled mutation, as in Convex.
      return this.limits.mutation.run(async () => {
        const timer = timed(this.newTimer());
        const run = () => this.withAudit(db, () => withUserTimer(timer, () => this.invoke(f, db, a, 0, job)));
        const value = await this.warned(db, a, timer, async () =>
          this.checkReturns(f, await (env ? withEnv(env, run) : run())),
        );
        checkDeadline(deadline);
        return value;
      });
    });
  }

  /**
   * Run a top-level query or mutation (one attempt) collecting its `log.audit` lines (STUDY-82); when it ends,
   * whether it succeeded or not, they are resolved with the request's variables and sent to the log streams
   * as `custom_audit` events, as Convex's function runner does. Over the limits, the run fails with that.
   */
  private async withAudit<T>(db: Tx, fn: () => Promise<T>): Promise<T> {
    const { lines, result } = collectingAuditLines(fn);
    let value: T;
    try {
      value = await result;
    } catch (e) {
      if (lines.lines.length) this.emitAudit(lines, db);
      throw e;
    }
    if (lines.lines.length) this.emitAudit(lines, db);
    return value;
  }

  private emitAudit(lines: Parameters<typeof resolveAuditLines>[0], db: Tx) {
    const request = db.request;
    const now = wallClock();
    const bodies = resolveAuditLines(lines, {
      requestId: request?.requestId ?? "",
      ip: request?.ip ?? null,
      userAgent: request?.userAgent ?? null,
      now: Math.floor(now),
      // Convex's `convex_actor_var`: a member's or an access token's; a self-hosted admin key is neither.
      bunvexActor: null,
    });
    if (this.logManager?.active)
      outsideExecution(() =>
        this.logManager!.send(bodies.map((body) => ({ timestamp: now, event: { topic: "custom_audit", body } }))),
      );
  }

  /**
   * A function to run, resolved now; when that fails, the error is thrown when the body runs, after
   * `failWhileNotRunning` — Convex checks the run state before it resolves the path.
   */
  private fnLater<K extends FunctionDef["kind"]>(name: string, kind: K, fromClient: boolean, caller?: Caller) {
    try {
      const f = this.fn(name, kind, fromClient, caller);
      return () => f;
    } catch (e) {
      return (): Extract<FunctionDef, { kind: K }> => {
        throw e;
      };
    }
  }

  /**
   * Convex's `fail_while_not_running` (crates/udf/src/validation.rs, STUDY-63): a user function fails while
   * the deployment is paused. Read in the function's transaction, so a subscribed query reruns on unpause.
   */
  private async failWhileNotRunning(db: Tx): Promise<void> {
    const message = notRunningMessage(await this.engine.backendState.read(db));
    if (message !== null) throw new FunctionPathError(message);
  }

  /** The same, for an action or HTTP action: in a transaction of its own. */
  private async failActionWhileNotRunning(): Promise<void> {
    await this.engine.query((db) => this.failWhileNotRunning(db));
  }

  /**
   * Convex's limits on a query's or mutation's own time (STUDY-41): 1 s of user time
   * (DATABASE_UDF_USER_TIMEOUT_SECONDS) and 15 s awaiting the store (DATABASE_UDF_SYSTEM_TIMEOUT_SECONDS).
   * Each nested call gets its own; the caller's clock is paused during it.
   */
  userTimeoutMs = Number(process.env.DATABASE_UDF_USER_TIMEOUT_SECONDS ?? 1) * 1000;
  systemTimeoutMs = Number(process.env.DATABASE_UDF_SYSTEM_TIMEOUT_SECONDS ?? 15) * 1000;
  private newTimer = () => newUserTimer(this.userTimeoutMs, this.systemTimeoutMs);
  /** How long an action may run (STUDY-77): Convex's knobs, 1800 s, and 600 s for a `"use node"` one. */
  actionTimeoutMs = secondsKnob("V8_ACTION_USER_TIMEOUT_SECS", V8_ACTION_USER_TIMEOUT_MS);
  nodeActionTimeoutMs = secondsKnob("NODE_ACTION_USER_TIMEOUT_SECS", NODE_ACTION_USER_TIMEOUT_MS);

  /** Run a query's or mutation's handler on `db` at nesting `depth`, with its context. */
  private invoke(f: FunctionDef, db: Tx, args: AnyArgs, depth: number, job?: string): unknown {
    const nested = this.nestedCalls(db, f.kind as "query" | "mutation", depth);
    const ctx =
      f.kind === "query"
        ? {
            db: (db.vars ? readerView(db) : db) as unknown as QueryCtx["db"],
            auth: txAuth(db),
            storage: this.fileStorage?.reader(db) ?? noStorage,
            runQuery: nested.runQuery,
            meta: this.meta(f, db, undefined),
          }
        : {
            db: db as unknown as MutationCtx["db"],
            auth: txAuth(db),
            // The scheduled job this runs under, also when an action it ran called it (Convex propagates
            // `parent_scheduled_job` down the call tree): what it schedules after that job is canceled is
            // born canceled, and it may not cancel that job.
            scheduler: makeScheduler(this, { db, job: job ?? db.request?.scheduledFunctionId ?? undefined }),
            storage: this.fileStorage?.writer(db) ?? noStorage,
            runQuery: nested.runQuery,
            runMutation: nested.runMutation,
            meta: this.meta(f, db, undefined),
          };
    return notAQuery(
      inHandleScope({ db, engine: this.engine }, () =>
        (f.handler as (ctx: unknown, args: AnyArgs) => unknown)(ctx, args),
      ),
    );
  }

  /** @internal The engine the functions run on (the scheduler resolves function handles with it). */
  engineOf(): Engine {
    return this.engine;
  }

  /** The active user tables' names (`tableSize:sizeOfAllTables`). */
  userTableNames(): string[] {
    return [...this.engine.catalog.tables.keys()].filter((n) => !n.startsWith("_"));
  }

  /** Every function's canonical path (`dir/module.js:function`), for its handle (STUDY-50). */
  functionPaths(): string[] {
    return [...this.fns.keys()].map(canonicalPath);
  }

  /**
   * `ctx.meta` (STUDY-44), as Convex's `setupQueryMeta` / `setupMutationMeta` / `setupActionMeta` and their
   * syscalls: a query's has no request metadata, an action's no transaction metrics nor snapshot.
   */
  private meta(f: FunctionDef, db: Tx | null, caller: Caller | undefined) {
    const key = f === HTTP_ACTION ? "http:default" : (this.names.get(f) ?? "");
    const name = key.endsWith(":default") ? key.slice(0, -":default".length) : key;
    const getFunctionMetadata = async () => ({ name, componentPath: "", type: f.kind, visibility: f.visibility });
    // Self-hosted Convex: the instance name, no region, the smallest class.
    const getDeploymentMetadata = async () => ({ name: this.engine.instanceName, region: null, class: "s16" });
    const request = (): CallRequest => db?.request ?? caller?.request ?? REQUESTLESS();
    const getRequestMetadata = async () => {
      const r = request();
      return {
        ip: r.ip,
        userAgent: r.userAgent,
        requestId: r.requestId,
        scheduledFunctionId: r.scheduledFunctionId,
        authToken: r.authToken,
      };
    };
    if (!db) return { getFunctionMetadata, getDeploymentMetadata, getRequestMetadata };
    const getTransactionMetrics = async () => {
      const used = db.usage;
      const limit = db.limits;
      const metric = (k: keyof typeof used) => ({ used: used[k], remaining: limit[k] - used[k] });
      // Convex never counts file reads or writes in a transaction: used 0, its default limits.
      const unused = (max: number) => ({ used: 0, remaining: max });
      return {
        bytesRead: metric("bytesRead"),
        bytesWritten: metric("bytesWritten"),
        databaseQueries: metric("databaseQueries"),
        documentsRead: metric("documentsRead"),
        documentsWritten: metric("documentsWritten"),
        functionsScheduled: metric("functionsScheduled"),
        scheduledFunctionArgsBytes: metric("scheduledFunctionArgsBytes"),
        filesWritten: unused(10),
        fileWriteBytes: unused(1 << 24),
        filesRead: unused(10),
        fileReadBytes: unused(1 << 24),
      };
    };
    // The snapshot in nanoseconds; reading it makes the result time-dependent, as `Date.now()` does.
    const getSnapshotTs = () => {
      observeTime();
      return BigInt(db.snapshot) * 1000n;
    };
    const meta = { getFunctionMetadata, getTransactionMetrics, getDeploymentMetadata, getSnapshotTs };
    return f.kind === "mutation" ? { ...meta, getRequestMetadata } : meta;
  }

  /**
   * `ctx.runQuery` (queries and mutations) and `ctx.runMutation` (mutations), as Convex's `1.0/runUdf`
   * (STUDY-41): the function runs in the caller's transaction — its writes, identity and time, its reads
   * joining the caller's read set — after its path, kind, arguments and the depth are checked; a nested
   * mutation is a sub-transaction, rolled back if it throws; its result is checked after (a failed check
   * keeps the writes, as Convex). `useStaleSnapshot` (mutations): a query at the transaction's snapshot,
   * without its pending writes, its reads discarded. `transactionLimits` lowers the read and write limits
   * for the call. Any error reaches the caller as a catchable one.
   */
  private nestedCalls(db: Tx, callerKind: "query" | "mutation", depth: number) {
    // One queue per running function: Convex runs its nested calls one at a time, in call order (STUDY-41
    // N4). Per function, not per transaction: a nested function's own calls must not wait for its caller's.
    let queue: Promise<unknown> = Promise.resolve();
    const call = (kind: "query" | "mutation", ref: FunctionRef, args: unknown, opts?: NestedOptions) => {
      if (opts?.useStaleSnapshot && callerKind === "query")
        throw new Error("`useStaleSnapshot` is only supported in mutations, not queries.");
      // Where the caller called: its error's frames (Convex raises it at the call, in the caller's code).
      const site = new Error();
      const run = queue
        .then(() => pausingUserTime(() => this.runNested(db, kind, ref, args, opts, depth)))
        .catch((e) => {
          throw atCallSite(e, site);
        });
      queue = run.catch(() => {});
      return run;
    };
    return {
      runQuery: (ref: FunctionRef, args?: unknown, opts?: NestedOptions) => call("query", ref, args, opts),
      runMutation:
        callerKind === "mutation"
          ? (ref: FunctionRef, args?: unknown, opts?: NestedOptions) => call("mutation", ref, args, opts)
          : undefined,
    };
  }

  private async runNested(
    db: Tx,
    kind: "query" | "mutation",
    ref: FunctionRef,
    args: unknown,
    opts: NestedOptions | undefined,
    depth: number,
  ): Promise<unknown> {
    const name = registryKey(await functionNameOf(ref, db, this.engine));
    const f = this.fn(name, kind, false);
    const a = this.checkArgs(f, args === undefined ? {} : args);
    if (depth >= MAX_NESTED_CALL_DEPTH)
      throw new Error("Cross component call depth limit exceeded. Do you have an infinite loop in your app?");
    if (opts?.useStaleSnapshot) {
      const caller: Caller = { identity: db.identity, key: "" };
      const timer = this.newTimer();
      let value: unknown;
      try {
        value = await this.engine.query(
          (stale) => {
            stale.identity = db.identity;
            return this.withLimits(stale, opts.transactionLimits, () =>
              withUserTimer(timer, () => this.invoke(f, stale, a, depth + 1)),
            );
          },
          undefined,
          undefined,
          caller,
          db.snapshot,
        );
      } catch (e) {
        throw this.nestedError(e, timer);
      }
      return acrossCall(this.checkReturns(f, value));
    }
    const sp = kind === "mutation" ? db.begin() : null;
    let value: unknown;
    const timer = this.newTimer();
    try {
      value = await this.withLimits(db, opts?.transactionLimits, () =>
        withUserTimer(timer, () => this.invoke(f, db, a, depth + 1)),
      );
    } catch (e) {
      if (sp) db.rollback(sp);
      throw this.nestedError(e, timer);
    }
    return acrossCall(this.checkReturns(f, value));
  }

  /**
   * What a nested call's failure becomes for its caller: a system error (the store failed) cannot be caught —
   * the whole request fails (STUDY-41 N6); anything else is the caller's catchable error (N2).
   */
  private nestedError(e: unknown, timer: UserTimer): unknown {
    if (isSystemError(e)) {
      failExecution(e as Error);
      return e;
    }
    return toCallerError(e, timer);
  }

  /**
   * Run `fn` with `db`'s limits lowered by `budget` (Convex's `TransactionLimits::from_budget`: each limit
   * becomes the usage so far plus the budget, never above the current one), restored after. The file limits
   * are accepted and ignored: Convex never counts file reads or writes in a transaction either.
   */
  private async withLimits<T>(db: Tx, budget: NestedOptions["transactionLimits"], fn: () => T): Promise<Awaited<T>> {
    if (!budget) return await fn();
    const saved = db.limits;
    const usage = db.usage;
    const lower = (k: keyof typeof saved, b: number | undefined) =>
      b === undefined ? saved[k] : Math.min(usage[k] + b, saved[k]);
    db.limits = {
      documentsRead: lower("documentsRead", budget.documentsRead),
      bytesRead: lower("bytesRead", budget.bytesRead),
      documentsWritten: lower("documentsWritten", budget.documentsWritten),
      bytesWritten: lower("bytesWritten", budget.bytesWritten),
      databaseQueries: lower("databaseQueries", budget.databaseQueries),
      functionsScheduled: lower("functionsScheduled", budget.functionsScheduled),
      scheduledFunctionArgsBytes: lower("scheduledFunctionArgsBytes", budget.scheduledFunctionArgsBytes),
    };
    try {
      return await fn();
    } finally {
      db.limits = saved;
    }
  }

  /**
   * The canonical name (`module.js:function`) of a function to schedule, which must exist, of any kind or
   * visibility (Convex's `validate_schedule_args`; the kind is checked when the job runs).
   */
  scheduledTarget(name: string): string {
    const key = registryKey(name);
    const i = key.lastIndexOf(":");
    const [module, fn] = [key.slice(0, i), key.slice(i + 1)];
    if (![...this.fns.keys()].some((k) => k.slice(0, k.lastIndexOf(":")) === module))
      throw new Error(`Attempted to schedule function at nonexistent path: ${module}.js`);
    if (!this.fns.has(key))
      throw new Error(
        `Attempted to schedule function, but no exported function ${fn} found in the file: ${module}.js. Did you forget to export it?`,
      );
    return `${module}.js:${fn}`;
  }

  /**
   * Arguments sent as an array of other than one (Convex's `UdfArgsJson`: each element an argument): a
   * function with a validator refuses them (`check_args`), after its path resolves as the run's would; one
   * without takes the first, as Convex's handler does (STUDY-67 H6).
   */
  checkArity(name: string, kind: FunctionDef["kind"], args: Value[], caller?: Caller): void {
    if (args.length === 1 || isSystemPath(name)) return;
    const f = this.fnLater(name, kind, true, caller)();
    if (f.args)
      throw ValidatorError.args(
        `Expected to receive a single object as the function's argument. Instead received ${args.length} arguments: ${displayValue(args)}`,
      );
  }

  /** A system function's arguments, checked as Convex's validators. */
  private systemArgs(args: Record<string, unknown> | unknown, validators: Record<string, GenericValidator>) {
    const a = args === undefined ? {} : args;
    if (!isSimpleObject(a))
      throw ValidatorError.args(
        `Expected to receive an object as the function's argument. Instead received: ${displayValue((a ?? null) as Value)}`,
      );
    const msg = checkValue(v.object(validators), a as Value, this.tableOf);
    if (msg) throw ValidatorError.args(msg);
    return a as never;
  }

  /**
   * A system query's body (`_system/frontend/*`, system-functions.ts): Convex's names, argument checks and
   * result shapes. From a client, only an admin (or the system) finds it, and its key must allow the
   * function's operation (Convex's `queryPrivateSystem("ViewData")`).
   */
  /** A client's access to a system function: only an admin finds it, and needs its operation. */
  private systemAccess(n: string, f: SystemQuery | undefined, fallback: DeploymentOp, caller?: Caller) {
    const admin = adminOf(caller);
    if (admin && caller?.identity != null) this.requireOperation(caller, "ActAsUser");
    if (!f || !admin) throw notFound(n);
    if (!f.noPermissionRequired) this.requireOperation(caller, f.op ?? fallback);
  }

  /**
   * Whether `caller` may run the query `name` from a client (throws as running it would). Sync checks it
   * before it reuses another session's run of the same query, as Convex checks visibility before its cache.
   */
  checkQueryAccess(name: string, caller?: Caller) {
    if (isSystemPath(name)) {
      const n = name.replace(/:default$/, "");
      this.systemAccess(n, SYSTEM_QUERIES[n], "ViewData", caller);
    } else this.checkAccess(this.fns.get(name) ?? this.fns.get(registryKey(name)), name, "query", caller);
  }

  private systemQueryBody(name: string, args: unknown, fromClient: boolean, caller?: Caller) {
    const n = name.replace(/:default$/, "");
    const q = SYSTEM_QUERIES[n];
    if (fromClient) this.systemAccess(n, q, "ViewData", caller);
    else if (!q) throw notFound(n);
    const a = this.systemArgs(args, q!.args);
    return (db: Tx) => {
      noteTx(db); // metered as Convex's system functions' bandwidth (STUDY-71)
      // Convex warns for system functions too (their clients get the lines; STUDY-76). They have no time
      // budget in bunvex: a timer that never fails measures their user time against Convex's 1 s.
      const timer = newUserTimer(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
      return this.warned(
        db,
        a,
        timer,
        () => withUserTimer(timer, () => q!.handler(db, a, { files: this.fileStorage, functions: this, caller })),
        this.userTimeoutMs,
      );
    };
  }

  private systemMutationBody(name: string, args: unknown, fromClient: boolean, caller?: Caller) {
    const n = name.replace(/:default$/, "");
    const m = SYSTEM_MUTATIONS[n];
    if (fromClient) this.systemAccess(n, m, "WriteData", caller);
    else if (!m) throw notFound(n);
    const a = this.systemArgs(args, m!.args);
    return (db: Tx) => {
      noteTx(db); // metered as Convex's system functions' bandwidth (STUDY-71)
      // Convex warns for system functions too (their clients get the lines; STUDY-76). They have no time
      // budget in bunvex: a timer that never fails measures their user time against Convex's 1 s.
      const timer = newUserTimer(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
      return this.warned(
        db,
        a,
        timer,
        () => withUserTimer(timer, () => m!.handler(db, a, { files: this.fileStorage, functions: this, caller })),
        this.userTimeoutMs,
      );
    };
  }

  /** A dashboard system query, in process (as the system: no key involved). */
  async runSystemQuery(name: string, args: unknown = {}): Promise<unknown> {
    return this.engine.query(this.systemQueryBody(name, args, false));
  }

  /** A dashboard system mutation, in process; one transaction, as Convex's. */
  async runSystemMutation(name: string, args: unknown = {}): Promise<unknown> {
    return this.engine.mutation(this.systemMutationBody(name, args, false), name);
  }

  /** A cron's target, checked at start as Convex checks it at push (`validate_cron_jobs`): its canonical name. */
  cronTarget(identifier: string, name: string): string {
    const key = registryKey(name);
    const canonical = `${key.slice(0, key.lastIndexOf(":"))}.js${key.slice(key.lastIndexOf(":"))}`;
    const f = this.fns.get(key);
    if (!f) throw new Error(`The cron job '${identifier}' schedules a function that does not exist: ${canonical}`);
    if (f.kind === "query")
      throw new Error(
        `The cron job '${identifier}' schedules a query function, only actions and mutations can be scheduled: ${canonical}`,
      );
    return canonical;
  }

  /** What a scheduled job runs, or why it cannot run (Convex's run-time check: the module may have changed). */
  scheduledKind(canonical: string): { kind: "mutation" | "action" } | { error: string } {
    const key = registryKey(canonical);
    const i = key.lastIndexOf(":");
    const [module, fn] = [key.slice(0, i), key.slice(i + 1)];
    const f = this.fns.get(key);
    if (!f) {
      if (![...this.fns.keys()].some((k) => k.slice(0, k.lastIndexOf(":")) === module))
        return { error: `Couldn't find JavaScript module '${module}.js'.` };
      return { error: `Couldn't find "${fn}" in module "${module}.js".` };
    }
    if (f.kind === "mutation" || f.kind === "action") return { kind: f.kind };
    // Convex's message, its stray quotes and line break included.
    const kind = f.kind[0].toUpperCase() + f.kind.slice(1);
    return {
      error: `Unsupported function type. FunctionName("${fn}") in module "${module}.js" is defined as a ${kind}. "\n                            "Only Mutation and Action can be scheduled.`,
    };
  }

  /** @internal The body of a scheduled mutation or cron, for an executor to run in its own transaction. */
  scheduledMutationBody(canonical: string, args: unknown, job?: string) {
    const f = this.fn(registryKey(canonical), "mutation", false);
    return this.mutationBody(() => f, args, job);
  }

  async runQuery(name: string, args: unknown, fromClient = true, caller?: Caller): Promise<unknown> {
    return this.logged(
      "Query",
      name,
      caller,
      () =>
        this.engine.query(
          this.queryBody(name, args, fromClient, caller),
          this.cacheKey(name, args),
          cachedQueryLogs,
          caller,
        ),
      returned,
      undefined,
      args,
    );
  }
  /** A query's result as JSON, for the HTTP API (a cache hit is sent as stored, with its log lines). */
  async runQueryJson(name: string, args: unknown, caller?: Caller): Promise<string> {
    return this.logged(
      "Query",
      name,
      caller,
      () =>
        this.engine.queryJson(
          this.queryBody(name, args, true, caller),
          this.cacheKey(name, args),
          cachedQueryLogs,
          caller,
        ),
      returnedJson,
      undefined,
      args,
    );
  }

  /**
   * A query at snapshot `ts` (≤ the visible ts), as JSON: the HTTP API's `query_at_ts`. Through the query
   * cache, as in Convex: a result cached at or before `ts` and still valid at `ts` answers it.
   */
  async runQueryAtJson(name: string, args: unknown, ts: number, caller?: Caller): Promise<string> {
    // As Convex's snapshot manager: a transaction may not begin further back than MAX_TRANSACTION_WINDOW
    // (OutOfRetention, a "try again later" system error). Every other transaction begins at the latest ts.
    this.engine.committer.checkBeginTs(ts);
    const body = this.queryBody(name, args, true, caller);
    return this.logged(
      "Query",
      name,
      caller,
      () => this.engine.queryJson(body, this.cacheKey(name, args), cachedQueryLogs, caller, ts),
      returnedJson,
      undefined,
      args,
    );
  }

  async runMutation(name: string, args: unknown, fromClient = true, caller?: Caller): Promise<unknown> {
    return (await this.runMutationWithTs(name, args, fromClient, caller)).value;
  }

  /** The same, with the commit ts (what the sync protocol's MutationResponse carries). */
  runMutationWithTs(
    name: string,
    args: unknown,
    fromClient = true,
    caller?: Caller,
    deadline?: Deadline,
  ): Promise<{ value: unknown; ts: number }> {
    // The name is the write source other mutations' OCC errors cite (STUDY-21).
    if (isSystemPath(name))
      return this.engine.mutationWithTs(
        untilAborted(this.systemMutationBody(name, args, fromClient, caller), deadline),
        name,
        caller,
        THROTTLED,
      );
    return this.logged(
      "Mutation",
      name,
      caller,
      () =>
        this.engine.mutationWithTs(
          this.mutationBody(this.fnLater(name, "mutation", fromClient, caller), args, undefined, deadline),
          name,
          caller,
          THROTTLED,
        ),
      (r) => returned(r.value),
      undefined,
      args,
    );
  }

  /**
   * A sync session's mutation (STUDY-23 §4.3): run at most once per request. A resend of a request that
   * already committed answers the recorded result and log lines (`replayed`) without running again.
   */
  runSessionMutation(
    name: string,
    args: unknown,
    request: SessionRequestId,
    caller?: Caller,
    deadline?: Deadline,
  ): Promise<{ ts: number } & ({ value: unknown } | { replayed: SessionRequestOutcome })> {
    const run = () =>
      this.engine.sessionMutation(
        isSystemPath(name)
          ? untilAborted(this.systemMutationBody(name, args, true, caller), deadline)
          : this.mutationBody(this.fnLater(name, "mutation", true, caller), args, undefined, deadline),
        name,
        request,
        // Recorded after the handler returns: its result, and the lines of this attempt (logs.ts).
        (value) => ({ result: stringifyValue(value), logLines: currentLogLines() }),
        caller,
        THROTTLED,
      );
    // A replayed request did not run: nothing to log.
    return this.logged(
      "Mutation",
      name,
      caller,
      run,
      (r) => ("value" in r ? returned(r.value) : { skip: true }),
      undefined,
      args,
    );
  }

  /**
   * An action; the queries and mutations it runs act as its caller (Convex passes the identity on). `job`:
   * the scheduled job it runs as (what it schedules after that job is canceled is born canceled).
   */
  async runAction(
    name: string,
    args: unknown,
    caller?: Caller,
    /** `authError`: the calling action's token failed verification (an HTTP action's), passed on. */
    opts: { job?: string; internal?: boolean; authError?: Error | null; waitForPermit?: boolean } = {},
  ): Promise<unknown> {
    return this.logged(
      "Action",
      name,
      caller,
      async () => {
        await this.failActionWhileNotRunning();
        const f = this.fn(opts.internal ? registryKey(name) : name, "action", !opts.internal, caller);
        const ctx = this.actionCtx(caller, opts.authError ?? null, opts.job, f);
        const a = this.checkArgs(f, args);
        // Node actions have their own limiter; scheduled and cron runs wait for a permit (STUDY-68).
        const node = NODE_FUNCTIONS.has(f);
        const limiter = node ? this.limits.nodeAction : this.limits.action;
        // The timeout runs from when the action holds its permit (STUDY-77).
        const ms = node ? this.nodeActionTimeoutMs : this.actionTimeoutMs;
        const timeout = node
          ? () => nodeActionTimeoutError(registryKey(name).slice(registryKey(name).lastIndexOf(":") + 1), ms)
          : () => actionTimeoutError(ms);
        return limiter.run(
          async () => {
            const t0 = performance.now();
            // Convex's action warnings (STUDY-76), when it returned or threw the app's error; Node actions'
            // runtime has none.
            const warn = (resultBytes: number | null) => {
              if (node) return;
              actionWarnings({
                argsBytes: rawValueSize([a as Value]),
                maxArgsBytes: this.maxArgsSize,
                pending: meteredAction()?.pendingOps ?? new Map(),
                elapsedMs: performance.now() - t0,
                resultBytes,
                maxResultBytes: this.maxResultSize,
              });
            };
            try {
              const value = this.checkReturns(
                f,
                await withActionTimeout(ms, timeout, () =>
                  this.inActionEnv(() => inHandleScope({ db: null, engine: this.engine }, () => f.handler(ctx, a))),
                ),
              );
              warn(sizeOfResult(value ?? null));
              return value;
            } catch (e) {
              if (!isSystemError(e)) warn(null);
              throw e;
            }
          },
          { wait: opts.waitForPermit === true },
        );
      },
      returned,
      undefined,
      args,
    );
  }

  /**
   * An action's context. `authError`: the request's token failed verification (an HTTP action still runs,
   * as in Convex): `getUserIdentity()` throws it, and the queries and mutations it calls run with no identity.
   * The actions it calls get the error too, as Convex passes them the same identity (STUDY-66 §5).
   */
  private actionCtx(caller: Caller | undefined, authError: Error | null, job?: string, f?: FunctionDef): ActionCtx {
    const identity = (caller?.identity ?? null) as UserIdentity | null;
    return trackedCtx({
      auth: {
        getUserIdentity: async () => {
          if (authError) throw authError;
          return copy(identity);
        },
      },
      // Once the action timed out, nothing it calls starts (STUDY-77).
      runQuery: async (n: FunctionRef, a?: unknown) => {
        checkActionAlive();
        return acrossCall(
          await unavailableAsError(
            this.runQuery(registryKey(await functionNameOf(n, null, this.engine)), a, false, caller),
          ),
        );
      },
      runMutation: async (n: FunctionRef, a?: unknown) => {
        checkActionAlive();
        return acrossCall(
          await unavailableAsError(
            this.runMutation(registryKey(await functionNameOf(n, null, this.engine)), a, false, caller),
          ),
        );
      },
      runAction: async (n: FunctionRef, a?: unknown) => {
        checkActionAlive();
        return acrossCall(
          await this.runAction(await functionNameOf(n, null, this.engine), a, caller, { internal: true, authError }),
        );
      },
      // As a mutation's: the job also reaches an action that a scheduled action ran.
      scheduler: cutOffWithAction(
        makeScheduler(this, {
          engine: this.engine,
          job: job ?? caller?.request?.scheduledFunctionId ?? undefined,
        }),
      ),
      storage: cutOffWithAction(this.fileStorage?.actionWriter(storageMeter) ?? noStorage),
      vectorSearch: async (tableName: string, indexName: string, query: VectorSearchQuery) => {
        checkActionAlive();
        // Convex's JS-side checks (vector_search_impl.ts), then the engine's (STUDY-51).
        const args = [tableName, indexName, query];
        const argNames = ["tableName", "indexName", "query"];
        for (let i = 0; i < 3; i++)
          if (args[i] === undefined)
            throw new TypeError(`Must provide arg ${i + 1} \`${argNames[i]}\` to \`vectorSearch\``);
        if (!Array.isArray(query.vector) || query.vector.length === 0)
          throw new Error("`vector` must be a non-empty Array in vectorSearch");
        const filter = query.filter ? query.filter(VECTOR_FILTER_BUILDER as never) : undefined;
        const r = meteredAction();
        let results: { _id: string; _score: number }[];
        try {
          results = this.engine.vectorSearch(
            tableName,
            indexName,
            {
              vector: query.vector,
              ...(query.limit === undefined ? {} : { limit: query.limit }),
              ...(filter === undefined ? {} : { filter }),
            },
            (bytes) => {
              if (r) r.io.vectorQueryBytes += bytes;
            },
          );
        } catch (e) {
          throw unavailableToAction(e);
        }
        // Each result is Convex's vector egress: its id's 33 bytes and its 4-byte score.
        if (r) r.io.vectorReadBytes += results.length * 37;
        return results;
      },
      ...(f ? { meta: this.meta(f, null, caller) } : {}),
    } as ActionCtx);
  }

  /** @internal Run an HTTP action's handler with an action's context, holding an action permit. */
  runHttpAction(
    handler: (ctx: ActionCtx, request: Request) => Promise<Response> | Response,
    request: Request,
    caller: Caller,
    authError: Error | null,
    /** The route matched (its `path` or `pathPrefix`): the app metrics' name for it, as Convex's. */
    routePath?: string,
  ): Promise<unknown> {
    const ctx = this.actionCtx(caller, authError, undefined, HTTP_ACTION);
    let t0 = 0;
    let running: Running | null = null;
    let body: ReturnType<typeof meteredBody> | null = null;
    // Convex's HTTP action warnings (STUDY-76), when its response is sent or its handler failed.
    const warnings = (sentBytes: number) =>
      httpActionWarnings({
        sentBytes,
        limitBytes: HTTP_ACTION_RESPONSE_LIMIT,
        pending: running?.pendingOps ?? new Map(),
        elapsedMs: performance.now() - t0,
      });
    // Logged under its route, as Convex's `HttpActionRoute` (`<METHOD> <path>`).
    const route = `${request.method} ${new URL(request.url).pathname}`;
    return this.logged(
      "HttpAction",
      route,
      caller,
      async () => {
        await this.failActionWhileNotRunning();
        // HTTP actions share the action limiter and the action timeout, as in Convex.
        const ms = this.actionTimeoutMs;
        return this.limits.action.run(async () => {
          t0 = performance.now();
          running = meteredAction();
          try {
            const response = await withActionTimeout(
              ms,
              () => actionTimeoutError(ms),
              () =>
                this.inActionEnv(() => inHandleScope({ db: null, engine: this.engine }, () => handler(ctx, request))),
            );
            if (!(response instanceof Response)) {
              warnings(0);
              return response;
            }
            // The headers before the body: Bun adds a Blob body's Content-Type (`new Response(blob)`) only if
            // they are read first.
            const headers = response.headers;
            if (!response.body) {
              warnings(0);
              return response;
            }
            // The body, sent as Convex's streamer does (20 MiB at most); the run is logged once it is.
            body = meteredBody(response.body, request.signal);
            return new Response(body.stream, { status: response.status, statusText: response.statusText, headers });
          } catch (e) {
            if (!isSystemError(e)) warnings(0);
            throw e;
          }
        });
      },
      // The handler ran to the end, but its client left before the head could be sent: as Convex, the
      // execution is logged as failed with "Client disconnected" (its writes stay).
      (r) =>
        request.signal.aborted
          ? { error: new ClientDisconnectedError() }
          : r instanceof Response
            ? { success: { status: String(r.status) } }
            : {},
      routePath ?? new URL(request.url).pathname,
      undefined,
      () =>
        body &&
        body.sent.then(({ bytes, errors, disconnected }) => () => {
          for (const e of errors) logSystemLine("ERROR", e, "error:httpAction");
          // The client left mid-body: Convex stops the run there and ends its lines with an INFO line (no
          // more lines or response parts will come); its run is still logged with the head's status.
          if (disconnected) logSystemLine("INFO", "Client disconnected", "info:httpActionClientDisconnect");
          else warnings(bytes);
        }),
    );
  }
}

/**
 * A mutation stops once its `deadline` is set (a WebSocket mutation's 60 s limit, STUDY-64 §1.1): checked
 * before each attempt and after the handler returns, so it never commits after the limit unless it had
 * already reached the committer — what Convex's dropped future does. `mutationBody` checks it itself; this
 * wraps a system mutation's body.
 */
function untilAborted<T>(body: (db: Tx) => Promise<T>, deadline: Deadline | undefined): (db: Tx) => Promise<T> {
  if (!deadline) return body;
  return async (db) => {
    checkDeadline(deadline);
    const value = await body(db);
    checkDeadline(deadline);
    return value;
  };
}

function checkDeadline(deadline: Deadline | undefined) {
  if (deadline?.aborted) throw new MutationAbortedError();
}

/** Set once a mutation must stop (its WebSocket's time limit passed); checked between its steps. */
export type Deadline = { aborted: boolean };

/** A mutation stopped by its `Deadline`: nobody waits for its answer any more. */
class MutationAbortedError extends Error {
  override name = "MutationAbortedError";
  constructor() {
    super("The mutation was stopped: its time limit passed");
  }
}

// Printed by name only: `console.log` of one never shows the engine's state (inspect.ts).
opaqueToInspect(Functions);
