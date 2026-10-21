// The function runtime: query / mutation / action definitions (a handler, or `{ args, returns, handler }`
// with validators, as Convex — STUDY-13), the registry that names them ("module:fn"), internal functions,
// and the calls the transports make. Transactions themselves run in
// the engine (@bunvex/core); this layer only decides WHICH body runs and with what context.
import vm from "node:vm";
import type { UserIdentity } from "@bunvex/auth";
import {
  boolKnob,
  type Caller,
  type CallRequest,
  checkEnvVarName,
  componentInParent,
  directFetch,
  type Engine,
  failExecution,
  formatBytes,
  type GenericTableInfo,
  IndexesUnavailableError,
  isQueryObject,
  knob,
  newUserTimer,
  notRunningMessage,
  OccError,
  observeTime,
  opaqueToInspect,
  outsideExecution,
  pausingUserTime,
  rootComponent,
  type SessionRequestId,
  type SessionRequestOutcome,
  type Span,
  secondsKnob,
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
import { type AnyFunctionReference, getFunctionAddress, getFunctionName } from "@bunvex/protocol";
import {
  BunvexError,
  checkJsonValue,
  checkValue,
  copyValue,
  displayValue,
  type GenericValidator,
  hasCommitTs,
  isBunvexError,
  isBytes,
  isSimpleObject,
  jsonSurrogateError,
  MAX_VALUE_NESTING,
  measureRawValue,
  rawValueSize,
  refuseLoneSurrogates,
  TOO_NESTED_MESSAGE,
  toJsonValue,
  type Value,
  v,
  valueHasLoneSurrogate,
} from "@bunvex/values";
import { isolateFetch, nodeFetch } from "./action-fetch.ts";

/**
 * A nested call's result as its caller gets it: Convex's crosses a JSON boundary (`runUdf` and the action
 * calls return `jsonToConvex` of the callee's `convexToJson(result === undefined ? null : result)`), so it is
 * a copy, `undefined` is `null`, `undefined` fields are gone and object fields come sorted (`copyValue`: the
 * same as that round trip, without building the JSON).
 */
const acrossCall = (value: unknown): Value => copyValue((value === undefined ? null : value) as Value);

/**
 * A nested call's arguments as the callee gets them: Convex sends `convexToJson(args)`, which Rust parses into a
 * `ConvexValue` (its objects sorted), so the callee sees a copy with each object's fields sorted and no
 * `undefined` field. The arguments are checked by the callee (`checkArgs`), so this only copies: anything that
 * is not plain data is left as it is, for that check to refuse with Convex's message.
 */
function acrossArgs(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(acrossArgs);
  if (isBytes(v)) return v.slice(0);
  if (!isSimpleObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) {
    const x = (v as Record<string, unknown>)[k];
    if (x !== undefined) out[k] = acrossArgs(x);
  }
  return out;
}

/**
 * A mutation's result must be a value before it commits: Convex converts it inside the run
 * (`invokeMutation`, registration_impl.ts), so a result that is not one (`undefined` in an array, a function,
 * a class instance) is the function's own error and none of its writes stay. The conversion is the wire's,
 * so the message is the one a later conversion would have given.
 */
const mustBeValue = <T>(value: T): T => {
  toJsonValue((value === undefined ? null : value) as Value);
  return value;
};

/**
 * Arguments' size and nesting, in one walk. Convex parses the positional args array, `[args]`, as a value
 * (`parse_udf_args`, crates/udf/src/helpers.rs), so its nesting limit leaves the arguments 63 levels, then
 * measures that array (`validate_udf_args_size`). The walk goes one level past the limit, for `runNested`.
 */
const measureArgs = (args: unknown) =>
  measureRawValue([(args === undefined ? {} : args) as Value], MAX_VALUE_NESTING + 1);

import {
  ActionPermits,
  type ConcurrencyLimiter,
  type FunctionLimits,
  functionLimitsFromEnv,
} from "./action-permits.ts";
import {
  type ActionLife,
  ActionTimeoutError,
  actionTimeoutError,
  checkActionAlive,
  currentActionLife,
  cutOffWithAction,
  endedError,
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
  SystemIdentityRequiredError,
} from "./admin-keys.ts";
import { appContext } from "./app-errors.ts";
import type { AppMetrics } from "./app-metrics.ts";
import {
  type AnyArgs,
  exportedValidator,
  type FunctionDef,
  NODE_FUNCTIONS,
  REMOTE_FUNCTIONS,
  REMOTE_GATES,
  type ValidatorExport,
} from "./builders.ts";
import { readCanonicalUrls, withCanonical } from "./canonical-urls.ts";
import { tooDeepToStringify } from "./deep-values.ts";
import { type EnvReader, withAllEnv, withEnv } from "./env-scope.ts";
import {
  describeUncaught,
  FunctionPathError,
  FunctionPathNotFoundError,
  isSystemError,
  newRequestId,
  UndecodedArgs,
  ValidatorError,
} from "./errors.ts";
import {
  canonicalPath,
  componentFunctionName,
  functionAddress,
  functionNameOf,
  inActionScope,
  inHandleScope,
  splitComponentFunctionName,
} from "./function-handles.ts";

export { componentFunctionName, splitComponentFunctionName };

import {
  type CallerName,
  type Completion,
  type ExecutionLinks,
  type FunctionLog,
  type IdentityType,
  NO_USAGE,
  Running,
  type UdfType,
  usageStats,
} from "./function-log.ts";
import { HTTP_ACTION_RESPONSE_LIMIT, meteredBody, type SentBody } from "./http-body.ts";
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
  withSubFunction,
} from "./logs.ts";
import { withNodeProcessErrors } from "./node-process-errors.ts";
import { setOperationTracker } from "./pending-ops.ts";
import type { GenericActionCtx, GenericMutationCtx, GenericQueryCtx, VectorSearchQuery } from "./registration.ts";
import { roomsCtx } from "./rooms/ctx.ts";
import { type AnyRoomDef, isRoomDef, type RoomGate } from "./rooms/define.ts";
import type { RoomHub } from "./rooms/hub.ts";
import type { HttpRouter, RoutableMethod } from "./router.ts";
import { makeScheduler, type Scheduler } from "./scheduler.ts";
import type { ServerMetrics } from "./server-metrics.ts";
import { setServiceCallContext } from "./service-tokens.ts";
import type { FileStorage, StorageMeter } from "./storage.ts";
import { UnparsedSystemArgs } from "./system-args.ts";
import { SYSTEM_MUTATIONS, SYSTEM_QUERIES, type SystemQuery } from "./system-functions.ts";
import type { UsageMeter } from "./usage-limits.ts";
import { bodyLength } from "./web-response.ts";

/** The query cache key: function name + the args' canonical Convex JSON (fields sorted, bigint safe), and the
 *  hash of the code it ran (a code version's module, STUDY-35), so a new version never reads an old result.
 *  `fromClient`: Convex keys the caller's `allowed_visibility` too (`StoredCacheKey`), `PublicOnly` for a client
 *  and `All` for an action's `ctx.runQuery`, so neither reuses the other's result. */
const cacheKeyOf = (hash: string, name: string, args: unknown, fromClient: boolean) =>
  `${hash}\u0000${name}\u0000${fromClient ? "public" : "all"}\u0000${stringifyValue(args ?? {})}`;

/** A function name as the registry keys it: `module:function`, `.js` stripped, `default` when unnamed. */
export const registryKey = (name: string) => {
  const i = name.lastIndexOf(":");
  const [module, fn] = i === -1 ? [name, "default"] : [name.slice(0, i), name.slice(i + 1)];
  return `${module.endsWith(".js") ? module.slice(0, -3) : module}:${fn}`;
};

/**
 * A component instance's runtime (STUDY-154): its `_components` id, its path (`a/b`), its variables' bindings
 * (resolved at push to values or deployment variables) and its HTTP prefix. Its functions sit in the registry
 * under `componentFunctionName(id, name)`.
 */
export type ComponentRuntime = {
  id: string;
  path: string;
  env: ReadonlyMap<string, { type: "value"; value: string } | { type: "envVar"; name: string }>;
  httpPrefix: string | null;
};

/**
 * A component's `process.env` (Convex's `udf/src/environment.rs`, STUDY-154): its bindings first (a value, or the
 * deployment's variable it names), then the built-ins, `BUNVEX_SITE_URL` with its HTTP prefix when it has one;
 * nothing else of the deployment's.
 */
/**
 * A variable of `vars` by name, never one of `Object.prototype`'s members (`process.env.constructor` is a name like
 * any other, unset unless set: Convex reads the variables one name at a time).
 */
const ownVar = (vars: Record<string, string>, name: string): string | undefined =>
  Object.hasOwn(vars, name) ? vars[name] : undefined;

function componentEnv(c: ComponentRuntime, read: EnvReader, builtin: Record<string, string>): EnvReader {
  return (name) => {
    const b = c.env.get(name);
    const bound = b === undefined ? undefined : b.type === "value" ? b.value : read(b.name);
    if (bound !== undefined) return bound;
    const site = ownVar(builtin, name);
    if (name === "BUNVEX_SITE_URL" && site !== undefined && c.httpPrefix !== null)
      return `${site}${c.httpPrefix.replace(/\/+$/, "")}`;
    return site;
  };
}

/** Convex's `ComponentPath::in_component_str`: ` in '<path>'`, nothing for the app. */
const inComponentStr = (path: string) => (path === "" ? "" : ` in '${path}'`);

/**
 * An index still being rebuilt after a start (STUDY-79), as an action sees it: Convex rejects the action's
 * syscall promise with a plain `Error` carrying the message, which the action may catch.
 */
const unavailableToAction = (e: unknown) => (e instanceof IndexesUnavailableError ? new Error(e.message) : e);

/** Convex's `parseArgs` (common/index.ts), first in a nested call's `runUdf` and an action's calls: an object, or none. */
function parseCallArgs(args: unknown) {
  if (args !== undefined && !isSimpleObject(args))
    throw new Error(`The arguments to a bunvex function must be an object. Received: ${args as unknown}`);
}

/**
 * An action's `runQuery` / `runMutation` / `runAction` arguments, checked at the call as Convex's `syscallArgs`
 * (`actions_impl.ts`) serializes them in the app's code before the syscall: a value that is not a supported one
 * throws there, synchronously, the app's frame on its stack (not as the callee's error); then arguments holding
 * a lone surrogate (STUDY-135): the `actions/*` text (the function's address, then the arguments) fails in serde.
 */
function checkActionCallArgs(ref: unknown, args: unknown) {
  parseCallArgs(args);
  try {
    checkJsonValue((args ?? {}) as Value);
  } catch (e) {
    // Made again here, so its stack (at most `Error.stackTraceLimit` frames) reaches the app's call, past the
    // serializer's recursion.
    throw e instanceof Error && e.constructor === Error ? new Error(e.message) : e;
  }
  refuseLoneSurrogates(args, () =>
    JSON.stringify({ ...functionAddress(ref), args: toJsonValue((args ?? {}) as Value) }),
  );
}

/**
 * A callee's error as the action that called it catches it (Convex's `actions_impl.ts` through
 * `performAsyncSyscall`): a new `Error` whose message is the callee's uncaught message (its line and frames),
 * or with data a `BunvexError` carrying it, as for a nested call in a mutation. A system error stays as it is.
 */
function toActionCallerError(e: unknown): unknown {
  if (e instanceof IndexesUnavailableError) return unavailableToAction(e);
  if (isSystemError(e)) return e;
  // Refused before the callee ran (its path, its arguments, a `_system/` identity, a timeout): Convex's
  // syscall error is that message alone, which these errors already are.
  if (
    e instanceof FunctionPathError ||
    e instanceof ValidatorError ||
    e instanceof ActionTimeoutError ||
    (e as { code?: unknown } | null)?.code === "SystemIdentityRequired"
  )
    return e;
  const message = describeUncaught(e).message;
  if (!isBunvexError(e)) return new Error(message);
  const err = new BunvexError<Value>(message);
  err.data = e.data;
  return err;
}
/**
 * The callee's error for the action that called it. Pushed code (its own vm context) gets it from its context's
 * wrapper (`installNestedCalls`), which converts the `NestedCallFailure` handed to it.
 */
const asActionCaller = <T>(p: Promise<T>, inContext: boolean): Promise<T> =>
  p.catch((e) => {
    throw inContext ? new NestedCallFailure(e) : toActionCallerError(e);
  });

/** A callee's failure on its way to the context's wrapper, which makes the caller's error from it. */
class NestedCallFailure {
  constructor(readonly cause: unknown) {}
}
const fromNestedCall = (e: unknown) => (e instanceof NestedCallFailure ? toActionCallerError(e.cause) : e);

/** Where a context keeps its wrapper: on its `Function.prototype`, so each of its functions reaches it. */
const NESTED_CALLS = Symbol("bunvex.nestedCalls");
type NestedCalls = <F extends (...a: never[]) => Promise<unknown>>(fn: F, convert: (e: unknown) => unknown) => F;

/**
 * A vm context's wrapper for an action's nested calls: an async function of the context's realm that awaits the
 * call and makes the caller's error there. Its stack then goes on to the action's own frame, where it awaited the
 * call (`at async …`), as Convex's error made in `performAsyncSyscall`; `mapStack` drops the server's frames and
 * this one (its file is not a pushed module's, `bunvex:/…`). JavaScriptCore follows `await`s within one realm
 * only: an error made in the server's code had server frames alone, which reached the client.
 */
export function installNestedCalls(context: object): void {
  const wrap = vm.runInContext(
    "(fn, convert) => async function (...a) { try { return await fn(...a); } catch (e) { throw convert(e); } }",
    context,
    { filename: "bunvex-runtime:nested-calls.js" },
  ) as NestedCalls;
  const fnProto = vm.runInContext("Function.prototype", context) as object;
  Object.defineProperty(fnProto, NESTED_CALLS, { value: wrap });
}

/**
 * How a mutation run by the function runner commits (STUDY-78): it checks the write throughput limit first,
 * as each of Convex's `run_mutation_no_udf_log` attempts does. Mutations a function calls inside its own
 * transaction do not: they are part of it.
 */
export const THROTTLED = { throttled: true } as const;

/** Convex's `MAX_REACTOR_CALL_DEPTH`: nested `runQuery` / `runMutation` levels below the top function. */
export const MAX_NESTED_CALL_DEPTH = knob("MAX_REACTOR_CALL_DEPTH", 8);

/**
 * Convex's file limits of a transaction (`TRANSACTION_MAX_NUM_FILES_WRITTEN` …): reported by
 * `getTransactionMetrics`, never counted, in Convex as here.
 */
const TRANSACTION_MAX_NUM_FILES_WRITTEN = knob("TRANSACTION_MAX_NUM_FILES_WRITTEN", 10);
const TRANSACTION_MAX_FILE_WRITE_SIZE_BYTES = knob("TRANSACTION_MAX_FILE_WRITE_SIZE_BYTES", 1 << 24);
const TRANSACTION_MAX_NUM_FILES_READ = knob("TRANSACTION_MAX_NUM_FILES_READ", 10);
const TRANSACTION_MAX_FILE_READ_SIZE_BYTES = knob("TRANSACTION_MAX_FILE_READ_SIZE_BYTES", 1 << 24);

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
 * A nested function's error as its caller sees it (Convex's `run_udf` and `performAsyncSyscall`): a new error
 * whose message is the nested `JsError`'s display — the uncaught line and the nested stack frames (STUDY-41
 * N2), or for a timeout its message alone. With data, a `BunvexError` carrying it: Convex's
 * `new ConvexError(e.message)` and then `data`, so the message is the uncaught one, not the data's.
 */
function toCallerError(e: unknown, timer: UserTimer): Error {
  if (isBunvexError(e)) {
    const err = new BunvexError<Value>(describeUncaught(e).message);
    err.data = e.data;
    return err;
  }
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

export type { StorageActionWriter, StorageReader, StorageWriter } from "./storage-api.ts";

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
export interface Auth {
  getUserIdentity(): Promise<UserIdentity | null>;
}
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

/** A query's definition. */
export type QueryDef = Extract<FunctionDef, { kind: "query" }>;

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
  systemIdentity: actingAs === null,
});
const adminOf = (caller: Caller | undefined) => (caller as AdminCaller | undefined)?.admin;
/**
 * Whether `caller` may reach a `_system/` function: an admin or the system acting as itself (Convex's
 * `identity.is_admin() || identity.is_system()`); not a user, nobody, nor an admin acting as a user.
 */
export const isSystemIdentity = (caller: Caller | undefined) =>
  adminOf(caller) !== undefined && caller!.identity == null;
const INTERNAL_OPS = {
  query: "RunInternalQueries",
  mutation: "RunInternalMutations",
  action: "RunInternalActions",
} as const satisfies Record<string, DeploymentOp>;
const isSystemPath = (name: string) => name.startsWith("_system/");

/**
 * A `_system/` function an admin asks for that does not exist, as Convex's module lookup words it (checked
 * against Convex's local backend): no such system module (`Couldn't find system module '"no/such.js"'.`, the
 * path without `_system/`), or no such function in one (`Couldn't find "nope" in module "_system/cli/tables.js".`).
 */
function systemNotFound(name: string): FunctionPathError {
  const key = registryKey(name);
  const i = key.lastIndexOf(":");
  const [module, fn] = [key.slice(0, i), key.slice(i + 1)];
  const exists = [...Object.keys(SYSTEM_QUERIES), ...Object.keys(SYSTEM_MUTATIONS)].some(
    (k) => registryKey(k).slice(0, registryKey(k).lastIndexOf(":")) === module,
  );
  return new FunctionPathError(
    exists
      ? `Couldn't find "${fn}" in module "${module}.js".`
      : `Couldn't find system module '"${module.slice("_system/".length)}.js"'.`,
  );
}
/**
 * An action's `runQuery` / `runMutation` / `runAction` of a `_system/` function: Convex's action runtime never
 * resolves one, whoever runs the action (`TaskExecutor::resolve`, "Couldn't resolve api._system.….<fn>").
 */
/** The function an action's call names, as the registry keys it; never a `_system/` one (`unresolvable`). */
const actionTarget = (name: string) => {
  if (isSystemPath(name)) throw unresolvable(name);
  return registryKey(name);
};
const unresolvable = (name: string) => new Error(`Couldn't resolve api.${registryKey(name).replace(/[/:]/g, ".")}`);
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
  REMOTE_FUNCTIONS,
  type RemoteRunner,
  type SandboxCall,
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

/** A function span's kind word: `query`, `mutation`, `action`, `http_action`. */
const spanKindOf = (udfType: UdfType) => (udfType === "HttpAction" ? "http_action" : udfType.toLowerCase());

/** End an execution's span with what it did: its path and kind, whether the cache answered, what it read. */
function functionSpanEnd(span: Span, r: Running, res: { ok: boolean; error?: unknown }) {
  span
    .set("bunvex.function.path", r.identifier)
    .set("bunvex.function.kind", spanKindOf(r.udfType))
    .set("bunvex.function.environment", r.environment)
    .set("bunvex.function.cached", r.cached)
    .set("bunvex.request_id", r.requestId);
  const tx = r.tx as Tx | null;
  if (tx) {
    const used = tx.usage;
    span.set("bunvex.function.documents_read", used.documentsRead).set("bunvex.function.bytes_read", used.bytesRead);
  }
  if (!res.ok) span.fail(res.error);
  span.finish();
}

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
// `getServiceToken` / `getServiceUrl` are action syscalls (STUDY-151 §4).
setServiceCallContext(inActionScope);

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

/** A redirected request's body, sent again (307, 308): metered as its own request, as Convex's (STUDY-142). */
function resentEgress(bytes: number) {
  const r = meteredAction();
  if (r && r.environment === "isolate") r.io.networkEgressBytes += bytes;
}

/**
 * The running action's operations still pending, by Convex's name for each (the unawaited-operations warning). The
 * function sandbox's host reads it to keep counting an operation whose answer its child had not taken when the
 * action returned (STUDY-171 §12). Null outside an action.
 */
export const currentPendingOps = (): Map<string, number> | null => meteredAction()?.pendingOps ?? null;

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

/**
 * The event loop's turns, counted lazily: a number that changes once a macrotask has run since it was read.
 * Convex hands an operation's answer to JS between turns of its loop, never in the turn that started it.
 */
let turn = 0;
let turnEnding = false;
function currentTurn(): number {
  if (!turnEnding) {
    turnEnding = true;
    setImmediate(() => {
      turn++;
      turnEnding = false;
    });
  }
  return turn;
}
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * `fn`'s promise, pending under `name` for the running action until it settles. An answer ready in the turn the
 * operation started (a call that settles within microtasks) is handed over in the next one, as Convex's tasks
 * are (STUDY-143): until then it is pending, and an action that returns without awaiting it lists it.
 */
function tracked<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const r = meteredAction();
  if (!r) return fn();
  // Nothing an action calls once it has ended starts (Convex's isolate ends with the action).
  const life = currentActionLife();
  if (life?.ended) return Promise.reject(endedError(life));
  const settle = pendingOp(r, name);
  const started = currentTurn();
  const handOver = async () => {
    if (turn === started) await nextTurn();
    settle();
  };
  return fn().then(
    async (value) => {
      await handOver();
      return value;
    },
    async (e: unknown) => {
      await handOver();
      throw e;
    },
  );
}

/**
 * An action's context whose operations count as pending until they settle, under Convex's names for them
 * (its syscalls, `name_when_dangling`): the unawaited-operations warning lists those still pending when the
 * action returns (STUDY-76).
 */
/** Each tracked `ctx`'s action life, once it is given one (`endsWith`). */
const LIVES = new WeakMap<object, { life?: ActionLife }>();
/** `ctx` (made by `trackedCtx`) refuses once `life` ended (STUDY-77 §7). */
const endsWith = (ctx: ActionCtx, life: ActionLife) => {
  LIVES.get(ctx)!.life = life;
};

function trackedCtx(ctx: ActionCtx): ActionCtx {
  const holder: { life?: ActionLife } = {};
  // biome-ignore lint/suspicious/noExplicitAny: wraps methods of every signature
  const wrap = <F extends (...a: any[]) => any>(name: string, fn: F | undefined): F =>
    (fn === undefined
      ? fn
      : (...a: Parameters<F>) =>
          // A `ctx` called after its action ended refuses, whoever calls it (Convex's ends with its isolate).
          holder.life?.ended ? Promise.reject(endedError(holder.life)) : tracked(name, async () => fn(...a))) as F;
  const c = ctx as unknown as Record<string, any>;
  const s = c.scheduler;
  const st = c.storage;
  const out = {
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
    rooms: {
      ...c.rooms,
      broadcast: wrap("rooms.broadcast", c.rooms.broadcast),
      members: wrap("rooms.members", c.rooms.members),
    },
    presence: { ...c.presence, list: wrap("presence.list", c.presence.list) },
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
    // `ctx.meta`'s calls are syscalls too (STUDY-143).
    ...(c.meta && {
      meta: {
        ...c.meta,
        getFunctionMetadata: wrap("getFunctionMetadata", c.meta.getFunctionMetadata),
        getDeploymentMetadata: wrap("getDeploymentMetadata", c.meta.getDeploymentMetadata),
        getRequestMetadata: wrap("getRequestMetadata", c.meta.getRequestMetadata),
      },
    }),
  } as unknown as ActionCtx;
  LIVES.set(out, holder);
  return out;
}

// `createFunctionHandle` and `log.audit` in an action, pending as `ctx`'s calls are (STUDY-143).
setOperationTracker(tracked);

/**
 * An HTTP action's request whose `formData()` is pending as `formData` until it settles when the body is
 * multipart: Convex parses that one with an operation (`form/parseMultiPart`), any other in JS (STUDY-143).
 */
function trackedFormData(request: Request): Request {
  if (!/^multipart\/form-data\b/i.test(request.headers.get("content-type") ?? "")) return request;
  const formData = request.formData.bind(request);
  Object.defineProperty(request, "formData", { value: () => tracked("formData", formData), configurable: true });
  return request;
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
/** Convex's `SYSTEM_FUNCTION_MAX_RESULT_SIZE` default: 24 MiB, for the `_system/` functions (STUDY-147). */
export const SYSTEM_FUNCTION_MAX_RESULT_SIZE = 24 << 20;

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
  /** A sync query's place in the subscriptions inspector, for its log entry's links (STUDY-131 AD-27). */
  subscription?: ExecutionLinks["subscription"];
};

/** Convex's `function_args_bytes`: the length of the arguments' JSON array, as the client sent it. */
const argsBytesOf = (args: unknown) => JSON.stringify([toJsonValue((args ?? {}) as Value)]).length;

/** What a logged execution's result tells the log. `skip`: nothing ran (a replayed session request). */
type Outcome = {
  returnBytes?: number | null;
  success?: { status: string } | null;
  error?: unknown;
  skip?: boolean;
  /**
   * An HTTP action's route, once it ran to the end: its Completion's name (`GET /files/*`) and its app metrics
   * name (`/files/*`). Without it the Completion keeps the request's name and the app metrics skip it (STUDY-31 §7).
   */
  route?: { identifier: string; metricsName: string };
};

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

/**
 * Convex's JS-side checks of `ctx.vectorSearch` (vector_search_impl.ts), in its order, and the filter's expression
 * (the app's filter function run on the builder), before the engine's checks (STUDY-51). The function sandbox's
 * child runs them at the app's call, and sends the expression (STUDY-171 §12).
 */
export function vectorSearchFilter(
  tableName: unknown,
  indexName: unknown,
  query: VectorSearchQuery<GenericTableInfo, string>,
): unknown {
  const args = [tableName, indexName, query];
  const argNames = ["tableName", "indexName", "query"];
  for (let i = 0; i < 3; i++)
    if (args[i] === undefined) throw new TypeError(`Must provide arg ${i + 1} \`${argNames[i]}\` to \`vectorSearch\``);
  if (!Array.isArray(query.vector) || query.vector.length === 0)
    throw new Error("`vector` must be a non-empty Array in vectorSearch");
  return query.filter ? query.filter(VECTOR_FILTER_BUILDER as never) : undefined;
}

/** An error a system function throws from its own code, without the app's frames (`systemArgs`). */
function systemArgsError(message: string): Error {
  const e = new Error(message);
  e.stack = `Error: ${message}`;
  return e;
}

export class Functions {
  private fns = new Map<string, FunctionDef>();
  /** Every room and presence definition (AD-42), by registry key, as `fns` keys functions. */
  rooms = new Map<string, AnyRoomDef>();
  /** The rooms' members in memory (AD-42); set by `createServer`. */
  roomHub: RoomHub | null = null;
  /** Each function's name as its key (`module:fn`), for `ctx.meta.getFunctionMetadata()`. */
  private names = new WeakMap<FunctionDef, string>();
  /** Each module's code hash (a deployed code version's modules); empty for registered (embedded) code. */
  private moduleHashes = new Map<string, string>();
  /** Each mounted component's functions (STUDY-154), by `componentFunctionName`. */
  private componentFns = new Map<string, FunctionDef>();
  /** Each mounted component's runtime and module hashes, by its `_components` id. */
  private componentRuntimes = new Map<
    string,
    { runtime: ComponentRuntime; hashes: Map<string, string>; router: HttpRouter | undefined }
  >();
  /** The component each of its functions belongs to. */
  private componentOf = new WeakMap<FunctionDef, ComponentRuntime>();

  /**
   * Install a component instance's code version (STUDY-154): its functions replace its previous ones, the app's and
   * the other components' untouched. Its modules were evaluated in its own contexts (C3, DV-492).
   */
  installComponent(
    runtime: ComponentRuntime,
    fns: Map<string, FunctionDef>,
    moduleHashes: Map<string, string>,
    moduleLoads: Map<string, string[]> = new Map(),
    /** Its `http.js` router, mounted where its parent's definition says (STUDY-157). */
    router?: HttpRouter,
  ) {
    this.removeComponent(runtime.id);
    for (const [key, f] of fns) {
      this.componentFns.set(componentFunctionName(runtime.id, key), f);
      this.componentOf.set(f, runtime);
      this.names.set(f, key);
      // The component's modules are its namespace's `_modules` rows: never the app's (STUDY-161 §16.7).
      const m = Functions.moduleOf(key);
      this.moduleLoads.set(
        f,
        (moduleLoads.get(m) ?? [m]).map((p) => `${runtime.id}\0${p}`),
      );
    }
    this.componentRuntimes.set(runtime.id, { runtime, hashes: new Map(moduleHashes), router });
  }

  /** Remove a component's functions (unmounted or deleted): calling one is "not found", as on Convex. */
  removeComponent(id: string) {
    const prefix = componentFunctionName(id, "x:x").slice(0, -"x:x".length);
    for (const key of [...this.componentFns.keys()]) if (key.startsWith(prefix)) this.componentFns.delete(key);
    this.componentRuntimes.delete(id);
  }

  /** An installed component's runtime and router, or undefined. */
  componentRuntime(id: string): { runtime: ComponentRuntime; router: HttpRouter | undefined } | undefined {
    return this.componentRuntimes.get(id);
  }

  /** The components whose code is installed, by id. */
  installedComponents(): string[] {
    return [...this.componentRuntimes.keys()];
  }

  /** A function name's module, as the registry and code versions key it (`dir/file` of `dir/file:fn`). */
  static moduleOf(name: string) {
    const key = registryKey(name);
    return key.slice(0, key.lastIndexOf(":"));
  }

  private cacheKey(name: string, args: unknown, fromClient = true): string | undefined {
    if (args instanceof UndecodedArgs || tooDeepToStringify(args)) return undefined;
    try {
      const c = splitComponentFunctionName(name);
      const hash = c
        ? this.componentRuntimes.get(c.id)?.hashes.get(Functions.moduleOf(c.name))
        : this.moduleHashes.get(Functions.moduleOf(name));
      return cacheKeyOf(hash ?? "", name, args, fromClient);
    } catch (e) {
      // Arguments too deep for the stack to stringify are past the nesting limit: no key, and the run's own
      // check refuses them with Convex's message (STUDY-109).
      if (e instanceof RangeError) return undefined;
      throw e;
    }
  }

  /**
   * Replace every function at once with a code version's (STUDY-35): the next call of any name runs the new
   * code. The modules whose code changed (added, removed or a new hash), for re-running what read them.
   */
  install(
    fns: Map<string, FunctionDef>,
    moduleHashes: Map<string, string>,
    rooms: Map<string, AnyRoomDef> = new Map(),
    moduleLoads: Map<string, string[]> = new Map(),
  ): Set<string> {
    const changed = new Set<string>();
    for (const [m, h] of moduleHashes) if (this.moduleHashes.get(m) !== h) changed.add(m);
    for (const m of this.moduleHashes.keys()) if (!moduleHashes.has(m)) changed.add(m);
    for (const k of this.fns.keys()) if (!fns.has(k)) changed.add(Functions.moduleOf(k));
    for (const k of fns.keys()) if (!this.fns.has(k)) changed.add(Functions.moduleOf(k));
    this.fns = new Map(fns);
    this.rooms = new Map(rooms);
    this.moduleHashes = new Map(moduleHashes);
    for (const [k, f] of fns) {
      const m = Functions.moduleOf(k);
      this.moduleLoads.set(f, moduleLoads.get(m) ?? [m]);
    }
    this.deployed = true;
    return changed;
  }

  /**
   * The modules each function's module loads (`CodeVersion.moduleLoads`), by function (the app's and every
   * component's); its own when not known.
   */
  private moduleLoads = new WeakMap<FunctionDef, string[]>();
  /**
   * Convex's reads before a function's code (STUDY-161 §16.3, §16.7): its configuration, its environment, the `_modules`
   * row of each module it loads (its own and the chunks it imports), and for a component's function one more
   * (`load_component_args`).
   */
  private countStartReads(db: Tx, f: FunctionDef) {
    db.countConstantReads(this.componentOf.has(f) ? 3 : 2);
    db.countModuleLoads(this.moduleLoads.get(f) ?? ["\0unknown"]);
  }

  /** Whether the functions are pushed code, which sees the deployment's variables (STUDY-37 E3). */
  private deployed = false;
  /** The built-in variables (the server's origins), read after the deployment's (which cannot hold them). */
  builtinEnv: Record<string, string> = {};
  /** The HTTP routes served (method, path), for `apiSpec`; the server sets it. */
  httpRoutes: () => readonly (readonly [string, string])[] = () => [];

  /** A query's or mutation's `process.env`: each read in `db`'s read set. */
  private async txEnv(db: Tx, component?: ComponentRuntime): Promise<EnvReader | null> {
    if (!this.deployed) return null;
    const read = await this.engine.environment.reader(db);
    // The canonical URLs in place of the origins (STUDY-49), read here so a change re-runs what read them.
    const builtin = withCanonical(this.builtinEnv, await readCanonicalUrls(db));
    if (component) return componentEnv(component, read, builtin);
    const reader: EnvReader = (name) => read(name) ?? ownVar(builtin, name);
    reader.variables = { deployment: read.vars, builtin };
    return reader;
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
        return ownVar(all, name);
      },
    };
  }

  /** Run `fn` under an action's environment. */
  private async inActionEnv<T>(fn: () => T | Promise<T>, component?: ComponentRuntime): Promise<T> {
    const env = await this.actionEnv();
    if (env && component) {
      // A component's: its bindings and the built-ins (STUDY-154), at the action's start.
      const read = componentEnv(component, (n) => env.read(n), this.builtinEnvNow(env));
      const all: Record<string, string> = {};
      for (const name of new Set([...component.env.keys(), ...Object.keys(this.builtinEnv)])) {
        const value = read(name);
        if (value !== undefined) all[name] = value;
      }
      return withAllEnv(all, read, fn);
    }
    return env ? withAllEnv(env.all, env.read, fn) : fn();
  }

  /** The built-ins as an action's start read them (their canonical URLs included). */
  private builtinEnvNow(env: { all: Record<string, string> }): Record<string, string> {
    return Object.fromEntries(Object.keys(this.builtinEnv).map((k) => [k, env.all[k] ?? this.builtinEnv[k]!]));
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
  logged<T>(
    udfType: UdfType,
    name: string,
    caller: Caller | undefined,
    run: () => Promise<T>,
    outcome?: (value: T) => Outcome,
    /** The arguments, for `function_args_bytes` (none for an HTTP action, as Convex's). */
    args?: unknown,
    /**
     * An HTTP action's run is logged once its response's body is sent, as Convex's (STUDY-76, DV-323):
     * `settled` gives the work to do then (in the run's log context), when it resolves.
     */
    settled?: (value: T) => Promise<() => void> | null,
  ): Promise<T> {
    // Traced (STUDY-131 AD-26): a span for the execution, under the request's, with what it read.
    const tracer = this.engine.tracer;
    const span = tracer.on ? tracer.child(`${spanKindOf(udfType)} ${strippedPath(name)}`) : null;
    if (span)
      return tracer.within(span, () => this.loggedRun(span, udfType, name, caller, run, outcome, args, settled));
    return this.loggedRun(null, udfType, name, caller, run, outcome, args, settled);
  }

  private async loggedRun<T>(
    span: Span | null,
    udfType: UdfType,
    name: string,
    caller: Caller | undefined,
    run: () => Promise<T>,
    outcome: ((value: T) => Outcome) | undefined,
    args: unknown,
    settled: ((value: T) => Promise<() => void> | null) | undefined,
  ): Promise<T> {
    const log = this.functionLog;
    // System functions are not logged, as in Convex, but their compute and bandwidth are metered.
    const system = isSystemPath(name);
    if (!log || (system && !this.usageMeter)) {
      if (!span) return run();
      span.set("bunvex.function.path", strippedPath(name)).set("bunvex.function.kind", spanKindOf(udfType));
      try {
        return await run();
      } catch (e) {
        span.fail(e);
        throw e;
      } finally {
        span.finish();
      }
    }
    const up = currentOwner();
    const parent = up instanceof Running ? up : null;
    // A component's function is logged by its own name and its component's path (STUDY-154).
    const inComponent = splitComponentFunctionName(name);
    if (inComponent) name = inComponent.name;
    const r = new Running(
      crypto.randomUUID(),
      parent?.requestId ?? caller?.request?.requestId ?? newRequestId(),
      parent,
      udfType,
      udfType === "HttpAction" ? name : strippedPath(name),
      parent ? "Action" : udfType === "HttpAction" ? "HttpEndpoint" : ((caller as SourcedCaller)?.source ?? "HttpApi"),
      identityTypeOf(caller),
      this.engine.runtime.now(),
      udfType === "Action" && this.isNodeAction(name) ? "node" : "isolate",
    );
    r.clock = this.engine.runtime;
    if (inComponent) r.componentPath = this.componentRuntimes.get(inComponent.id)?.runtime.path ?? null;
    r.tokenIdentifier = ((caller?.identity as { tokenIdentifier?: unknown } | null)?.tokenIdentifier as string) ?? null;
    r.ip = caller?.request?.ip ?? null;
    if (!system && (udfType === "Action" || udfType === "HttpAction"))
      r.onLine = (line) => {
        log.append({
          kind: "Progress",
          udfType,
          identifier: r.identifier,
          componentPath: r.componentPath,
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
    // An HTTP action's comes with its route (`Outcome.route`), once it ran to the end.
    r.metricsName = udfType === "HttpAction" ? "" : this.metricsNameOf(r.identifier);
    const sourced = caller as SourcedCaller | undefined;
    r.runReason = sourced?.runReason ?? null;
    r.mutationQueueLength = sourced?.mutationQueueLength ?? null;
    r.retries = sourced?.retries ?? { n: 0 };
    // Why it ran and its trace, for the dashboard (STUDY-131 AD-27).
    if (sourced?.subscription || span)
      r.links = {
        ...(sourced?.subscription && { subscription: sourced.subscription }),
        ...(span && { trace: { traceId: span.traceId, spanId: span.spanId } }),
      };
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
    if (span) functionSpanEnd(span, r, res);
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
  /** The Prometheus metrics (STUDY-114); set by `createServer`. */
  serverMetrics: ServerMetrics | null = null;
  /** Queries and mutations running now, for the metrics' `function_concurrency`. */

  /** Log a completion, and record it in the app metrics as Convex's `log_execution_app_metrics`. */
  /**
   * Where an event of `r` comes from (Convex's `FunctionEventSource`): an HTTP action's lines by the request
   * (`r.identifier`), its execution by its Completion's name (`identifier`).
   */
  private eventSource(r: Running, cached: boolean | null, identifier = r.identifier): FunctionSource {
    return {
      path: r.udfType === "HttpAction" ? identifier : this.metricsNameOf(identifier),
      componentPath: r.componentPath,
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
    const source = this.eventSource(r, c.udfType === "Query" ? c.cachedResult : null, c.identifier);
    const at = c.timestamp * 1000;
    const events: LogEvent[] = [];
    if (c.udfType !== "Action" && c.udfType !== "HttpAction")
      for (const line of c.logLines)
        events.push({
          timestamp: line.timestamp,
          event: {
            topic: "console",
            // A nested call's line names its function and component, as Convex's `SubFunction` (STUDY-155).
            source: line.subFunction
              ? {
                  ...source,
                  path: this.metricsNameOf(line.subFunction.path),
                  componentPath: line.subFunction.componentPath,
                }
              : source,
            line,
          },
        });
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
  private isolateSender = isolateFetch(proxiedFetch(directFetch, null), resentEgress);
  private proxy: HttpProxy | null = null;
  /** The proxy an isolate action's `fetch` goes through (Convex's `--convex-http-proxy`); null for none. */
  get httpProxy(): HttpProxy | null {
    return this.proxy;
  }
  set httpProxy(p: HttpProxy | null) {
    this.proxy = p;
    this.isolateSender = isolateFetch(proxiedFetch(directFetch, p), resentEgress);
  }

  /** A run's usage into the meter (STUDY-61, STUDY-71); `tracked`: whether the call counts (not `_system/`). */
  private meterCompletion(r: Running, c: Completion, tracked: boolean) {
    this.usageMeter?.recordExecution({
      udfType: c.udfType,
      environment: c.environment,
      // A cache hit meters no compute, as Convex's `CallType::CachedQuery`: its entry's user time and memory
      // are its run's, already metered (STUDY-174 F4).
      executionTime: c.cachedResult ? 0 : c.executionTime,
      userExecutionTime: c.cachedResult ? null : c.userExecutionTime,
      memoryMb: c.cachedResult ? 0 : c.usageStats.memoryUsedMb,
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
    // An HTTP action that did not run to the end under a route is not measured, as Convex's (STUDY-31 §7).
    if (r.metricsName !== "")
      this.appMetrics?.recordExecution({
        udfType: c.udfType,
        name: r.metricsName,
        at: c.timestamp * 1000,
        failed: c.error !== null,
        cached: c.cachedResult,
        executionTime: c.executionTime,
        ...(r.tx ? { tables: (r.tx as Tx).tableStats } : {}),
      });
    this.serverMetrics?.execution(c.udfType, c.error !== null, c.executionTime);
    this.meterCompletion(r, c, true);
  }

  private completion(r: Running, lines: LogLine[], o: Outcome, willRetry: boolean): Completion {
    const end = this.engine.runtime.now();
    const e = o.error;
    // A mutation's writes count once it committed (Convex meters them in `track_commit`).
    const used = (r.tx as Tx | null)?.io(r.udfType === "Mutation" && e === undefined);
    const seconds = (end - r.start) / 1000;
    // An HTTP action that ran to the end is named, and measured, by its route.
    if (o.route) r.metricsName = o.route.metricsName;
    // A cache hit gives the user time, memory, start and identity of the run it reused, as Convex's `log_query`
    // logs the cached outcome's (STUDY-174 F4); its own are its wall time, timestamp, request and caller.
    // A hit whose run kept none (never in practice) gives its own, with no memory.
    const ran = r.cached ? r.reused : r.figuresAt(end);
    return {
      kind: "Completion",
      udfType: r.udfType,
      identifier: o.route?.identifier ?? r.identifier,
      componentPath: r.componentPath,
      logLines: lines,
      timestamp: end / 1000,
      cachedResult: r.cached,
      caller: r.caller,
      parentExecutionId: r.parent?.executionId ?? null,
      executionTime: seconds,
      // How it is measured: `Running.figuresAt` (STUDY-71).
      userExecutionTime: ran?.userExecutionTime ?? seconds,
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
        // Convex's memory per execution (STUDY-61); a cache hit's is its run's.
        memoryUsedMb: ran?.memoryUsedMb ?? 0,
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
      executionTimestamp: ran?.executionTimestamp ?? r.start / 1000,
      identityType: (ran?.identityType as IdentityType | undefined) ?? r.identityType,
      environment: r.environment,
      ...(r.links && { links: r.links }),
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
    const rt = engine.runtime;
    this.limits =
      opts.limits ??
      functionLimitsFromEnv(process.env, opts.actionPermits ?? ActionPermits.fromEnv(process.env, rt), rt);
    this.actionPermits = this.limits.action;
  }

  register(module: string, fns: Record<string, FunctionDef | AnyRoomDef>) {
    for (const [n, f] of Object.entries(fns))
      if (isRoomDef(f)) this.rooms.set(`${module}:${n}`, f);
      else {
        this.fns.set(`${module}:${n}`, f);
        this.moduleLoads.set(f, [module]);
      }
    return this;
  }

  /** A room or presence definition by name (`rooms:doc`, or `rooms.doc`-style paths as functions take). */
  roomDef(name: string): AnyRoomDef | undefined {
    return this.rooms.get(registryKey(name));
  }

  /**
   * Convex's `require_operation`: the system may do anything, an admin what its key allows
   * (`OperationNotPermitted`); anyone else is told the deploy key is invalid (`BadDeployKey`).
   */
  requireOperation(caller: Caller | undefined, op: DeploymentOp) {
    const admin = adminOf(caller);
    if (!admin) throw new BadDeployKeyError();
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
    if (!f) throw this.notFound(name);
    if (f.visibility === "internal") {
      if (!admin) throw this.notFound(name);
      this.requireOperation(caller, INTERNAL_OPS[kind]);
    }
  }

  private fn<K extends FunctionDef["kind"]>(name: string, kind: K, fromClient: boolean, caller?: Caller) {
    // `dir/file` is its default export, and `.js` is optional, as Convex canonicalizes a path.
    const c = splitComponentFunctionName(name);
    const key = c ? componentFunctionName(c.id, c.name) : this.fns.has(name) ? name : registryKey(name);
    const f = c ? this.componentFns.get(key) : this.fns.get(key);
    if (f) this.names.set(f, key);
    // As Convex (crates/udf/src/validation.rs): a missing function and an internal one called from a
    // client read the same, with the path stripped (no `.js`, no `:default`); a function of another kind
    // names the canonical path (`module.js:name`) and both kinds.
    if (fromClient) this.checkAccess(f, name, kind, caller);
    else if (!f) throw this.notFound(name);
    if (!f) throw this.notFound(name);
    if (f.kind !== kind) {
      // A component's function names itself and its component (Convex's `in_component_str`, STUDY-155).
      const shown = c ? c.name : name;
      const where = c ? ` in '${this.componentRuntimes.get(c.id)?.runtime.path ?? ""}'` : "";
      const i = shown.lastIndexOf(":");
      const kindName = (k: string) => k[0].toUpperCase() + k.slice(1);
      const message = `Trying to execute ${shown.slice(0, i)}.js${shown.slice(i)}${where} as ${kindName(kind)}, but it is defined as ${kindName(f.kind)}.`;
      throw this.udf404OnBadPath
        ? new FunctionPathNotFoundError("FunctionPathWrongType", message)
        : new FunctionPathError(message);
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
    return this.lookup(name)?.kind ?? null;
  }

  /** A function by name, an app's or a component's (`componentFunctionName`), or undefined. */
  private lookup(name: string): FunctionDef | undefined {
    const c = splitComponentFunctionName(name);
    if (c) return this.componentFns.get(componentFunctionName(c.id, c.name));
    return this.fns.get(name) ?? this.fns.get(registryKey(name));
  }

  /** Whether a function is internal (false when it does not exist). */
  isInternal(name: string): boolean {
    return this.lookup(name)?.visibility === "internal";
  }

  /**
   * Convex's `_system/cli/modules:apiSpec`: every function, its kind, visibility and validators, then the
   * HTTP routes as `{ functionType: "HttpAction", method, path }`. The validators are what the function's
   * `exportArgs()` / `exportReturns()` give, as the push stored them: `{ type: "any" }` arguments and a `null`
   * result validator when the function declares none.
   */
  apiSpec(componentId?: string | null) {
    const kind = { query: "Query", mutation: "Mutation", action: "Action" } as const;
    // A component's (`componentId`, as Convex's `queryPrivateSystem` reads it): its functions and its own `http.js`
    // routes (STUDY-157).
    const routes = (
      componentId
        ? (this.componentRuntimes.get(componentId)?.router?.getRoutes() ?? []).map(([path, method]) => [method, path])
        : this.httpRoutes()
    ).map(([method, path]) => ({ functionType: "HttpAction", method, path }));
    const prefix = componentId ? componentFunctionName(componentId, "x:x").slice(0, -"x:x".length) : null;
    const entries: [string, FunctionDef][] =
      prefix === null
        ? [...this.fns]
        : [...this.componentFns]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, f]) => [key.slice(prefix.length), f]);
    const fns = entries.map(([key, f]) => {
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

  /** An id's table, for `v.id`: `_storage` for a `_file_storage` id, as Convex names it (STUDY-125). */
  private tableOf = (n: number) => this.engine.catalog.publicNameOf(n);

  /**
   * Convex's `FUNCTION_MAX_ARGS_SIZE` and `FUNCTION_MAX_RESULT_SIZE` (crates/common/src/knobs.rs, STUDY-64
   * §1.7): 16 MiB each, read from environment variables of the same names.
   */
  maxArgsSize = knob("FUNCTION_MAX_ARGS_SIZE", FUNCTION_MAX_ARGS_SIZE);
  maxResultSize = knob("FUNCTION_MAX_RESULT_SIZE", FUNCTION_MAX_RESULT_SIZE);
  /**
   * Convex's `UDF_404_ON_BAD_PATH` (default false; crates/udf/src/validation.rs): a path naming no public function,
   * or one of another kind, fails the request (404) instead of being the function's error (STUDY-147 §3.8).
   */
  udf404OnBadPath = boolKnob("UDF_404_ON_BAD_PATH", false);

  /** Convex's `missing_or_internal_error`: no such public function. */
  private notFound(name: string): Error {
    const message = `Could not find public function for '${name.replace(/:default$/, "")}'.`;
    return this.udf404OnBadPath
      ? new FunctionPathNotFoundError("FunctionPathNotFound", message)
      : new FunctionPathError(message);
  }
  /** The `_system/` functions' (Convex's `deserialize_udf_result`, crates/isolate/src/helpers.rs). */
  maxSystemResultSize = knob("SYSTEM_FUNCTION_MAX_RESULT_SIZE", SYSTEM_FUNCTION_MAX_RESULT_SIZE);

  /**
   * Arguments are an object, nested at most 63 levels, no larger than `maxArgsSize`, checked against `args`
   * when the function declares it (Convex's rules and order: `ValidatedPathAndArgs` in
   * crates/udf/src/validation.rs). `measured`: `measureArgs(args)`, when the caller has it already. Arguments
   * that did not decode fail here, once the function is resolved, as Convex's `parse_udf_args`.
   */
  private checkArgs(f: FunctionDef, args: unknown, measured?: ReturnType<typeof measureArgs>): AnyArgs {
    if (args instanceof UndecodedArgs) throw args.error;
    measured ??= measureArgs(args);
    const a = args === undefined ? {} : args;
    // Arguments a client sent with a lone surrogate do not parse into Convex's values (STUDY-135; nested
    // and scheduled calls are refused before, where their text is sent).
    if (valueHasLoneSurrogate(a)) throw new FunctionPathError("Invalid arguments provided");
    const { size, nesting, tooBig } = measured;
    if (nesting > MAX_VALUE_NESTING)
      throw new FunctionPathError(`Invalid arguments for ${this.pathOf(f)}: ${TOO_NESTED_MESSAGE}`);
    // Convex's `parse_udf_args`: an array over 8192 elements or an object over 1024 fields (DV-439).
    if (tooBig !== undefined) throw new FunctionPathError(`Invalid arguments for ${this.pathOf(f)}: ${tooBig}`);
    if (size > this.maxArgsSize)
      throw new FunctionPathError(
        `Arguments for ${this.pathOf(f)} are too large (actual: ${formatBytes(size)}, limit: ${formatBytes(this.maxArgsSize)})`,
      );
    // Without a validator, Convex hands the handler whatever came (a number, null); with one, the single
    // argument must be an object (`check_args`, after the size).
    if (f.args && !isSimpleObject(a))
      throw ValidatorError.args(
        `Expected to receive an object as the function's argument. Instead received: ${displayValue((a ?? null) as Value)}`,
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
    // Convex's JS sends the result to Rust as JSON text, which serde parses first: a lone surrogate fails it
    // (STUDY-135, `crates/isolate/src/helpers.rs`).
    if (valueHasLoneSurrogate(value)) {
      const e = jsonSurrogateError(JSON.stringify(toJsonValue((value ?? null) as Value)));
      if (e)
        throw new FunctionPathError(`Function ${this.pathOf(f)} failed. Could not parse return value as json: ${e}`);
    }
    // Convex's order: the value is parsed (its 64-level nesting limit), then measured — one walk here.
    // Convex converts the result in the app's code (`convexToJson`) before Rust parses, measures or checks it: a
    // result that is too deep, too large or fails `returns` because it is not a value (a `Set`, `undefined` in an
    // array) fails as one. Converted only then, so a result that passes costs no extra walk.
    const notAValue = () => checkJsonValue((value ?? null) as Value);
    const { size, nesting } = measureRawValue((value ?? null) as Value);
    if (nesting > MAX_VALUE_NESTING) {
      try {
        notAValue();
      } catch (e) {
        // Deeper than the stack: the nesting limit's message, as before (STUDY-109).
        if (!(e instanceof RangeError)) throw e;
      }
      throw new FunctionPathError(`Function ${this.pathOf(f)} return value invalid: ${TOO_NESTED_MESSAGE}`);
    }
    if (typeof value === "object" && value !== null) resultSizes.set(value, size);
    if (size > this.maxResultSize) {
      notAValue();
      throw new FunctionPathError(
        `Function ${this.pathOf(f)} return value is too large (actual: ${formatBytes(size)}, limit: ${formatBytes(this.maxResultSize)})`,
      );
    }
    if (f.returns) {
      const msg = checkValue(f.returns, (value ?? null) as Value, this.tableOf);
      if (msg) {
        notAValue();
        throw ValidatorError.returns(msg);
      }
    }
    return value;
  }

  /** A `_system/` function's result: no larger than `maxSystemResultSize`, else its error, as a user function's. */
  private checkSystemResult<T>(name: string, value: T): T {
    const size = rawValueSize((value ?? null) as Value);
    if (size > this.maxSystemResultSize)
      throw new FunctionPathError(
        `Function ${canonicalPath(name)} return value is too large (actual: ${formatBytes(size)}, limit: ${formatBytes(this.maxSystemResultSize)})`,
      );
    return value;
  }

  /** A function's canonical path for a limit message, as Convex prints `CanonicalizedUdfPath`: `module.js:fn`. */
  private pathOf(f: FunctionDef): string {
    return canonicalPath(this.names.get(f) ?? "");
  }

  /** The body a query runs, for the transports that manage their own transaction (subscriptions). */
  queryBody(name: string, args: unknown, fromClient = true, caller?: Caller, standalone?: QueryDef) {
    const body = this.queryBodyOf(name, args, fromClient, caller, standalone);
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

  /** A query's body; `standalone`, a query that is not deployed, runs as `name` (the function tester's). */
  private queryBodyOf(name: string, args: unknown, fromClient = true, caller?: Caller, standalone?: QueryDef) {
    if (isSystemPath(name) && !standalone) return this.systemQueryBody(name, args, fromClient, caller);
    const resolved = standalone ? () => standalone : this.fnLater(name, "query", fromClient, caller);
    return async (db: Tx) => {
      noteTx(db);
      await this.failWhileNotRunning(db);
      const f = resolved();
      const a = this.checkArgs(f, args);
      this.countStartReads(db, f);
      const env = await this.txEnv(db, this.componentOf.get(f));
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
      this.countStartReads(db, f);
      const env = await this.txEnv(db, this.componentOf.get(f));
      // A permit per attempt (STUDY-68), with the timeout even for a scheduled mutation, as in Convex.
      return this.limits.mutation.run(async () => {
        const timer = timed(this.newTimer());
        const run = () => this.withAudit(db, () => withUserTimer(timer, () => this.invoke(f, db, a, 0, job)));
        const value = await this.warned(db, a, timer, async () =>
          mustBeValue(this.checkReturns(f, await (env ? withEnv(env, run) : run()))),
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
  userTimeoutMs = secondsKnob("DATABASE_UDF_USER_TIMEOUT_SECONDS", 1);
  systemTimeoutMs = secondsKnob("DATABASE_UDF_SYSTEM_TIMEOUT_SECONDS", 15);
  private newTimer = () => newUserTimer(this.userTimeoutMs, this.systemTimeoutMs, this.engine.runtime.monotonicNow);
  /** How long an action may run (STUDY-77): Convex's knobs, 1800 s, and 600 s for a `"use node"` one. */
  actionTimeoutMs = secondsKnob("V8_ACTION_USER_TIMEOUT_SECS", V8_ACTION_USER_TIMEOUT_MS / 1000);
  nodeActionTimeoutMs = secondsKnob("NODE_ACTION_USER_TIMEOUT_SECS", NODE_ACTION_USER_TIMEOUT_MS / 1000);

  /** Run a query's or mutation's handler on `db` at nesting `depth`, with its context. */
  private invoke(f: FunctionDef, db: Tx, args: AnyArgs, depth: number, job?: string): unknown {
    const component = this.componentOf.get(f);
    const nested = this.nestedCalls(db, f.kind as "query" | "mutation", depth, component);
    const functions = this;
    let rooms: ReturnType<typeof roomsCtx>["rooms"] | undefined;
    const ctx =
      f.kind === "query"
        ? {
            db: (db.vars ? readerView(db) : db) as unknown as QueryCtx["db"],
            auth: txAuth(db),
            // A component's files are its namespace's, its URLs `?component=` (STUDY-157).
            storage: this.fileStorage?.reader(db, component?.id ?? null) ?? noStorage,
            runQuery: nested.runQuery,
            meta: this.meta(f, db, undefined),
          }
        : {
            db: db as unknown as MutationCtx["db"],
            auth: txAuth(db),
            // The scheduled job this runs under, also when an action it ran called it (Convex propagates
            // `parent_scheduled_job` down the call tree): what it schedules after that job is canceled is
            // born canceled, and it may not cancel that job.
            // In a component, its jobs are its namespace's (STUDY-157).
            scheduler: makeScheduler(this, {
              db,
              component,
              job: job ?? db.request?.scheduledFunctionId ?? undefined,
              jobComponent: db.request?.scheduledFunctionComponent ?? null,
            }),
            // Sent once the mutation committed; dropped if it throws or retries (AD-42). Built on first use:
            // most mutations broadcast nothing.
            get rooms() {
              rooms ??= roomsCtx(functions, (fn) => db.afterCommit(fn), false).rooms;
              return rooms;
            },
            storage: this.fileStorage?.writer(db, component?.id ?? null) ?? noStorage,
            runQuery: nested.runQuery,
            runMutation: nested.runMutation,
            meta: this.meta(f, db, undefined),
          };
    // A sandboxed function's handler is in its child: the stand-in gets the same `ctx`, and its transaction.
    const remote = REMOTE_FUNCTIONS.get(f);
    const run = remote
      ? () => remote(ctx, args, { db, shape: f.kind === "mutation" ? "writer" : db.vars ? "reader" : "tx" })
      : () => (f.handler as (ctx: unknown, args: AnyArgs) => unknown)(appContext(f.handler, ctx), args);
    return notAQuery(
      inHandleScope({ db, engine: this.engine, resolve: (ref) => this.resolveCall(ref, component, db, false) }, () =>
        component
          ? this.inComponentRun(db, component, run)
          : // The app's function called from a component (through a handle, STUDY-155): back in the app's namespace.
            db.componentId !== null
            ? this.inAppRun(db, run)
            : run(),
      ),
    );
  }

  /**
   * A component's function run in its namespace (STUDY-154): `ctx.db` its tables and schema, what Convex refuses in
   * a component refused (`Tx.componentFunction`).
   */
  private async inAppRun(db: Tx, run: () => unknown): Promise<unknown> {
    const was = db.componentFunction;
    db.componentFunction = false;
    try {
      return await db.inComponent(null, async () => run());
    } finally {
      db.componentFunction = was;
    }
  }

  private async inComponentRun(db: Tx, component: ComponentRuntime, run: () => unknown): Promise<unknown> {
    const was = db.componentFunction;
    db.componentFunction = true;
    try {
      return await db.inComponent(component.id, async () => run());
    } finally {
      db.componentFunction = was;
    }
  }

  /** @internal The engine the functions run on. */
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
    // A component's function is registered under its component's id: its own name is the part after it.
    const registered = f === HTTP_ACTION ? "http:default" : (this.names.get(f) ?? "");
    const key = splitComponentFunctionName(registered)?.name ?? registered;
    const name = key.endsWith(":default") ? key.slice(0, -":default".length) : key;
    // A component's function names its component's path (`a/b`), as Convex's `function_metadata`; the app's "".
    const componentPath = this.componentOf.get(f)?.path ?? "";
    const getFunctionMetadata = async () => ({ name, componentPath, type: f.kind, visibility: f.visibility });
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
        filesWritten: unused(TRANSACTION_MAX_NUM_FILES_WRITTEN),
        fileWriteBytes: unused(TRANSACTION_MAX_FILE_WRITE_SIZE_BYTES),
        filesRead: unused(TRANSACTION_MAX_NUM_FILES_READ),
        fileReadBytes: unused(TRANSACTION_MAX_FILE_READ_SIZE_BYTES),
      };
    };
    // The snapshot in nanoseconds; reading it makes the result time-dependent, as `Date.now()` does.
    const getSnapshotTs = () => {
      observeTime();
      return db.snapshot;
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
  private nestedCalls(db: Tx, callerKind: "query" | "mutation", depth: number, component?: ComponentRuntime) {
    // One queue per running function: Convex runs its nested calls one at a time, in call order (STUDY-41
    // N4). Per function, not per transaction: a nested function's own calls must not wait for its caller's.
    let queue: Promise<unknown> = Promise.resolve();
    const call = (kind: "query" | "mutation", ref: FunctionRef, args: unknown, opts?: NestedOptions) => {
      if (opts?.useStaleSnapshot && callerKind === "query")
        throw new Error("`useStaleSnapshot` is only supported in mutations, not queries.");
      // Where the caller called: its error's frames (Convex raises it at the call, in the caller's code).
      const site = new Error();
      const run = queue
        .then(() => {
          // Convex's `runUdf` text (registration_impl.ts): serde reads it first (STUDY-135).
          refuseLoneSurrogates(args, () =>
            JSON.stringify({
              udfType: opts?.useStaleSnapshot ? "snapshotQuery" : kind,
              args: toJsonValue((args ?? {}) as Value),
              ...functionAddress(ref),
            }),
          );
          return pausingUserTime(() => this.runNested(db, kind, ref, args, opts, depth, component));
        })
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

  /**
   * The registry name of the function a call names (Convex's `ComponentsModel::resolve`, STUDY-155): a name in the
   * caller's own component, any visibility; a reference to a public export of one of the caller's direct children; a
   * handle. `action`: an action's call, whose misses read as Convex's preloaded map's, "Couldn't resolve …".
   */
  private async resolveCall(
    ref: unknown,
    caller: ComponentRuntime | undefined,
    db: Tx | null,
    action: boolean,
  ): Promise<string> {
    let address: ReturnType<typeof getFunctionAddress> | null = null;
    try {
      address = getFunctionAddress(ref);
    } catch {}
    if (address && "reference" in address) return this.resolveReference(address.reference, caller, db, action);
    const name = await functionNameOf(ref, db, this.engine);
    // A handle names its function (the app's until STUDY-155 PR 2); a name is the caller's component's.
    if (address && "functionHandle" in address) return name;
    return caller && !isSystemPath(name) ? componentFunctionName(caller.id, name) : name;
  }

  /** A `_reference/…` path resolved from `caller`'s component (Convex's `resolve` and `resolve_export`). */
  private async resolveReference(
    reference: string,
    caller: ComponentRuntime | undefined,
    db: Tx | null,
    action: boolean,
  ): Promise<string> {
    const parts = reference.split("/");
    if (parts[0] !== "_reference") throw new Error(`Invalid reference: ${reference}`);
    const [kind, first, ...rest] = parts.slice(1);
    if (kind === "function" && first !== undefined) {
      const name = [first, ...rest].join("/");
      return caller ? componentFunctionName(caller.id, name) : name;
    }
    if (kind === "componentArgument")
      throw new Error(
        caller ? `Component argument '${first}' not found` : "Can't use an argument reference in the app",
      );
    if (kind === "currentSystemUdfInComponent")
      throw new Error(
        caller
          ? "CurrentSystemUdfInComponent only available in root component"
          : "CurrentSystemUdfInComponent must be called from a system UDF",
      );
    if (kind !== "childComponent" || first === undefined) throw new Error(`Invalid reference ${reference}`);
    const child = first;
    const attributes = rest;
    // An action's misses all read the same (Convex's preloaded map); a query's and a mutation's name the child or the
    // export. A branch, not a function, is a 400 from either (DV-531).
    const miss = (message: string) =>
      new Error(action ? `Couldn't resolve ${[child, ...attributes].join(".")}` : message);
    const read = <T>(fn: (tx: Tx) => Promise<T>) => (db ? fn(db) : this.engine.query(fn));
    const row = await read(async (tx) => {
      const parent = caller ? caller.id : (await rootComponent(tx))?._id;
      return parent === undefined ? null : componentInParent(tx, parent, child);
    });
    if (!row) throw miss(`Child component '${child}' not found`);
    const exportPath = attributes.join(".");
    const notExported = () => miss(`Child component '${child}' does not export '${exportPath}'`);
    if (attributes.length < 2) throw notExported();
    const key = componentFunctionName(row._id, `${attributes.slice(0, -1).join("/")}:${attributes.at(-1)}`);
    // Only a public function is exported (Convex's `file_based_exports`); an unmounted child exports nothing.
    if (this.lookup(key)?.visibility !== "public") throw notExported();
    return key;
  }

  private async runNested(
    db: Tx,
    kind: "query" | "mutation",
    ref: FunctionRef,
    args: unknown,
    opts: NestedOptions | undefined,
    depth: number,
    /** The calling component's: a name resolves among its functions (STUDY-154); other components are step 5. */
    component?: ComponentRuntime,
  ): Promise<unknown> {
    // Convex's `runUdf` (registration_impl.ts) takes an object (`parseArgs`) and converts it in the app's code first
    // (`convexToJson`): what is not a value fails before anything else, its original object in the app's own field
    // order. Deeper than the stack, the nesting checks below answer (DV-363).
    parseCallArgs(args);
    try {
      checkJsonValue((args ?? {}) as Value);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
    }
    // Convex's `runUdf` syscall parses `args` as a value of its own before it resolves the function, so past
    // 64 levels its check speaks; at 64, the callee's (`[args]` is 65).
    const measured = measureArgs(args);
    if (measured.nesting > MAX_VALUE_NESTING + 1)
      throw new Error(`Invalid argument \`args\` for \`runUdf\`: ${TOO_NESTED_MESSAGE}`);
    if (measured.tooBig !== undefined) throw new Error(`Invalid argument \`args\` for \`runUdf\`: ${measured.tooBig}`);
    // Resolving the reference reads the component tree (Convex's component registry, the engine's own reads): not
    // counted (STUDY-161 §16.7).
    const target = await db.notCounted(() => this.resolveCall(ref, component, db, false));
    const name = splitComponentFunctionName(target) ? target : registryKey(target);
    // A `_system/` function, as Convex's (checked against its local backend): not found to anyone but an admin
    // or the system; for them it runs, in this transaction.
    if (isSystemPath(name)) {
      // the outcome depends on who calls: the query cache keeps it per caller
      db.readIdentity();
      if (!db.systemIdentity) throw this.notFound(name);
      if (depth >= MAX_NESTED_CALL_DEPTH)
        throw new Error("Cross component call depth limit exceeded. Do you have an infinite loop in your app?");
      // Convex's first nested call reads two more things into the transaction (STUDY-161 §16.3).
      db.countNestedCall();
      const body =
        kind === "query"
          ? this.systemQueryBody(name, args, false, undefined, true)
          : this.systemMutationBody(name, args, false, undefined, true);
      return kind === "query" ? db.inQueryScope(() => body(db)) : body(db);
    }
    const f = this.fn(name, kind, false);
    // Convex's first nested call in a transaction (STUDY-161 §16.7, measured): two reads, one more from a component,
    // one more into another namespace (the callee's, by its registry name: a handle may lead back to the app), and
    // the callee's modules not loaded yet; later nested calls count nothing more.
    const callee = splitComponentFunctionName(name)?.id ?? null;
    db.countNestedCall(
      (component ? 1 : 0) + (callee !== (component?.id ?? null) ? 1 : 0),
      this.moduleLoads.get(f) ?? ["\0unknown"],
    );
    const a = acrossArgs(this.checkArgs(f, args === undefined ? {} : args, measured)) as AnyArgs;
    // Its lines name it (Convex's `SubFunction`): its own name and its component's path.
    const inner = splitComponentFunctionName(name);
    const sub = {
      componentPath: inner ? (this.componentRuntimes.get(inner.id)?.runtime.path ?? null) : null,
      path: strippedPath(inner ? inner.name : name),
    };
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
              withUserTimer(timer, () => withSubFunction(sub, () => this.invoke(f, stale, a, depth + 1))),
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
    // A query called from a mutation paginates in a scope of its own; from a query, in its caller's (Convex 8449d41).
    const run = () => withUserTimer(timer, () => withSubFunction(sub, () => this.invoke(f, db, a, depth + 1)));
    try {
      value = await this.withLimits(db, opts?.transactionLimits, () =>
        kind === "query" ? db.inQueryScope(run) : run(),
      );
      if (sp) mustBeValue(value);
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
   * The function a scheduler names (Convex's `schedule` and `validate_schedule_args`, STUDY-157): resolved from the
   * caller's component as its calls are (STUDY-155: a name in its own component, a child's export, a handle), then
   * checked to exist, of any kind or visibility (the kind is checked when the job runs). Its component path and
   * canonical path (`module.js:function`), as the job stores them.
   */
  async scheduleTarget(
    ref: unknown,
    caller: ComponentRuntime | undefined,
    db: Tx | null,
    systemIdentity: boolean,
    action: boolean,
  ): Promise<{ component: string; udfPath: string }> {
    const resolved = await this.resolveCall(ref, caller, db, action);
    const c = splitComponentFunctionName(resolved);
    const name = c ? c.name : resolved;
    // Convex reads the target's module first (`ModuleModel::get_metadata`), which refuses a `_system/` module
    // to anyone but an admin or the system.
    if (!c && isSystemPath(name) && !systemIdentity) throw new SystemIdentityRequiredError("get_module");
    const key = registryKey(name);
    const i = key.lastIndexOf(":");
    const [module, fn] = [key.slice(0, i), key.slice(i + 1)];
    const component = c ? (this.componentRuntimes.get(c.id)?.runtime.path ?? "") : "";
    const fns = this.functionsIn(c ? c.id : null);
    if (![...fns.keys()].some((k) => k.slice(0, k.lastIndexOf(":")) === module))
      throw new Error(
        `Attempted to schedule function at nonexistent path: ${component === "" ? "" : `${component} `}${module}.js`,
      );
    if (!fns.has(key))
      throw new Error(
        `Attempted to schedule function, but no exported function ${fn} found in the file: ${module}.js${inComponentStr(component)}. Did you forget to export it?`,
      );
    return { component, udfPath: `${module}.js:${fn}` };
  }

  /** The functions of component `id` (the app's for null), by `module:fn`. */
  private functionsIn(id: string | null): Map<string, FunctionDef> {
    if (id === null) return this.fns;
    const prefix = componentFunctionName(id, "x:x").slice(0, -"x:x".length);
    const out = new Map<string, FunctionDef>();
    for (const [key, f] of this.componentFns) if (key.startsWith(prefix)) out.set(key.slice(prefix.length), f);
    return out;
  }

  /** The path of installed component `id` (`a/b`), the app's (`""`) for null; undefined when its code is not installed. */
  componentPathOf(id: string | null): string | undefined {
    return id === null ? "" : this.componentRuntimes.get(id)?.runtime.path;
  }

  /** The id of the component at `path` whose code is installed (`""`: the app, null), or undefined. */
  private componentAt(path: string): string | null | undefined {
    if (path === "") return null;
    for (const [id, { runtime }] of this.componentRuntimes) if (runtime.path === path) return id;
    return undefined;
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

  /**
   * A system function's arguments, checked as Convex's validators. Convex does not analyze its system modules,
   * so their arguments are not checked before the run: each function checks its own, inside its handler
   * (system-udfs `_system/server.ts` `withArgsValidated`, the `validateArgs` op), and throws an `Error` with the
   * check's display. A client sees `Uncaught Error: <check>`, with no frames (the system modules show none).
   */
  private systemArgs(args: Record<string, unknown> | unknown, validators: Record<string, GenericValidator>) {
    // Arguments its reader refused (STUDY-161 §6): Convex's wrapper reads them first, after the access check.
    if (args instanceof UnparsedSystemArgs) throw systemArgsError(args.message);
    const a = args === undefined ? {} : args;
    if (!isSimpleObject(a))
      throw systemArgsError(
        `Expected to receive an object as the function's argument. Instead received: ${displayValue((a ?? null) as Value)}\n`,
      );
    // As Convex's `op_validate_args` (4991db1): an array over 8192 elements or an object over 1024 fields is a
    // user error before the validator ("Uncaught Error: Invalid arguments: …").
    // Past 64 levels (the backend's parse no longer refuses them for a system function, STUDY-161 §6) it is
    // that op's error too; at 64, `[args]` is 65 and the validator's own measure refuses it, without the prefix.
    const { tooBig, nesting } = measureRawValue([a as Value], Number.POSITIVE_INFINITY);
    if (nesting > MAX_VALUE_NESTING + 1) throw systemArgsError(`Invalid arguments: ${TOO_NESTED_MESSAGE}`);
    if (tooBig !== undefined) throw systemArgsError(`Invalid arguments: ${tooBig}`);
    if (nesting > MAX_VALUE_NESTING) throw systemArgsError(TOO_NESTED_MESSAGE);
    const msg = checkValue(v.object(validators), a as Value, this.tableOf);
    if (msg) throw systemArgsError(`${msg}\n`);
    return a as never;
  }

  /**
   * A system query's body (`_system/frontend/*`, system-functions.ts): Convex's names, argument checks and
   * result shapes. From a client, only an admin (or the system) finds it, and its key must allow the
   * function's operation (Convex's `queryPrivateSystem("ViewData")`).
   */
  /**
   * A client's access to a system function, as Convex's `application_function_runner`: refused to anyone but
   * an admin or the system acting as itself (403 `SystemIdentityRequired`, before the function is looked
   * up); then the function must exist, and the key must allow its operation.
   */
  private systemAccess(
    n: string,
    f: SystemQuery | undefined,
    fallback: DeploymentOp,
    kind: "query" | "mutation",
    caller?: Caller,
  ) {
    if (!isSystemIdentity(caller)) throw new SystemIdentityRequiredError(kind);
    if (!f) throw systemNotFound(n);
    if (!f.noPermissionRequired) this.requireOperation(caller, f.op ?? fallback);
  }

  /**
   * Whether `caller` may run the query `name` from a client (throws as running it would). Sync checks it
   * before it reuses another session's run of the same query, as Convex checks visibility before its cache.
   */
  checkQueryAccess(name: string, caller?: Caller) {
    if (isSystemPath(name)) {
      const n = name.replace(/:default$/, "");
      this.systemAccess(n, SYSTEM_QUERIES[n], "ViewData", "query", caller);
    } else this.checkAccess(this.fns.get(name) ?? this.fns.get(registryKey(name)), name, "query", caller);
  }

  private systemQueryBody(name: string, args: unknown, fromClient: boolean, caller?: Caller, inProcess = false) {
    const n = name.replace(/:default$/, "");
    const q = SYSTEM_QUERIES[n];
    if (fromClient) this.systemAccess(n, q, "ViewData", "query", caller);
    else {
      // function code never finds an admin-call-only query (STUDY-131 AD-24), as if it did not exist
      if (q?.adminCallOnly && !inProcess) throw this.notFound(n);
      // function code (an action's `runQuery`) reaches it only for an admin or the system, as Convex's runner;
      // no caller at all is the server itself, in process
      if (!inProcess && caller !== undefined && !isSystemIdentity(caller))
        throw new SystemIdentityRequiredError("query");
      if (!q) throw this.notFound(n);
    }
    const a = this.systemArgs(args, q!.args);
    return (db: Tx) => {
      noteTx(db); // metered as Convex's system functions' bandwidth (STUDY-71)
      // Convex's reads before a system function's code: its configuration and environment (STUDY-161 §16.3); a call
      // from function code counts as a nested call's.
      if (!inProcess) db.countConstantReads(2);
      // Convex warns for system functions too (their clients get the lines; STUDY-76). They have no time
      // budget in bunvex: a timer that never fails measures their user time against Convex's 1 s.
      const timer = newUserTimer(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, this.engine.runtime.monotonicNow);
      return this.warned(
        db,
        a,
        timer,
        () =>
          withUserTimer(timer, async () =>
            this.checkSystemResult(n, await q!.handler(db, a, { files: this.fileStorage, functions: this, caller })),
          ),
        this.userTimeoutMs,
      );
    };
  }

  private systemMutationBody(name: string, args: unknown, fromClient: boolean, caller?: Caller, inProcess = false) {
    const n = name.replace(/:default$/, "");
    const m = SYSTEM_MUTATIONS[n];
    if (fromClient) this.systemAccess(n, m, "WriteData", "mutation", caller);
    else {
      if (!inProcess && caller !== undefined && !isSystemIdentity(caller))
        throw new SystemIdentityRequiredError("mutation");
      if (!m) throw this.notFound(n);
    }
    const a = this.systemArgs(args, m!.args);
    return (db: Tx) => {
      noteTx(db); // metered as Convex's system functions' bandwidth (STUDY-71)
      // Convex's reads before a system function's code: its configuration and environment (STUDY-161 §16.3); a call
      // from function code counts as a nested call's.
      if (!inProcess) db.countConstantReads(2);
      // Convex warns for system functions too (their clients get the lines; STUDY-76). They have no time
      // budget in bunvex: a timer that never fails measures their user time against Convex's 1 s.
      const timer = newUserTimer(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, this.engine.runtime.monotonicNow);
      return this.warned(
        db,
        a,
        timer,
        () =>
          withUserTimer(timer, async () =>
            this.checkSystemResult(n, await m!.handler(db, a, { files: this.fileStorage, functions: this, caller })),
          ),
        this.userTimeoutMs,
      );
    };
  }

  /** A dashboard system query, in process (as the system: no key involved). */
  async runSystemQuery(name: string, args: unknown = {}): Promise<unknown> {
    return this.engine.query(this.systemQueryBody(name, args, false, undefined, true));
  }

  /** A dashboard system mutation, in process; one transaction, as Convex's. */
  async runSystemMutation(name: string, args: unknown = {}): Promise<unknown> {
    return this.engine.mutation(this.systemMutationBody(name, args, false, undefined, true), name);
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

  /**
   * What a scheduled job runs (its kind, and the name to run it by: the app's canonical path, a component's registry
   * name), or why it cannot run (Convex's run-time check: the module may have changed, or its component gone).
   */
  scheduledKind(canonical: string, component = ""): { kind: "mutation" | "action"; key: string } | { error: string } {
    const key = registryKey(canonical);
    const i = key.lastIndexOf(":");
    const [module, fn] = [key.slice(0, i), key.slice(i + 1)];
    const id = this.componentAt(component);
    const fns = id === undefined ? new Map<string, FunctionDef>() : this.functionsIn(id);
    const f = fns.get(key);
    if (!f) {
      if (![...fns.keys()].some((k) => k.slice(0, k.lastIndexOf(":")) === module))
        return { error: `Couldn't find JavaScript module '${module}.js'.` };
      return { error: `Couldn't find "${fn}" in module "${module}.js".` };
    }
    if (f.kind === "mutation" || f.kind === "action")
      return { kind: f.kind, key: id ? componentFunctionName(id, key) : canonical };
    // Convex's message, its stray quotes and line break included.
    const kind = f.kind[0].toUpperCase() + f.kind.slice(1);
    return {
      error: `Unsupported function type. FunctionName("${fn}") in module "${module}.js"${inComponentStr(component)} is defined as a ${kind}. "\n                            "Only Mutation and Action can be scheduled.`,
    };
  }

  /**
   * @internal The body of a scheduled mutation or cron, for an executor to run in its own transaction: `name` a
   * canonical path of the app's, or a registry name (`scheduledKind`'s `key`).
   */
  scheduledMutationBody(name: string, args: unknown, job?: string) {
    const f = this.fn(splitComponentFunctionName(name) ? name : registryKey(name), "mutation", false);
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
          this.cacheKey(name, args, fromClient),
          cachedQueryLogs,
          caller,
        ),
      returned,
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
      args,
    );
  }

  /**
   * A query that is not deployed, as JSON (STUDY-119): Convex's `execute_standalone_module` runs the function
   * tester's query with `run_query_without_caching`, so it never reads or fills the cache. It runs as `name`.
   */
  async runStandaloneQueryJson(
    f: QueryDef,
    name: string,
    args: unknown,
    caller?: Caller,
    /** The component it runs in (the dashboard's custom query in a component, STUDY-154), else the app. */
    componentId: string | null = null,
  ): Promise<string> {
    this.names.set(f, registryKey(name));
    if (componentId !== null) {
      // Convex's `must_component_path`: an id with no mounted component is a system error.
      const runtime = this.componentRuntimes.get(componentId)?.runtime;
      if (!runtime) throw new Error(`Component ${componentId} not found`);
      this.componentOf.set(f, runtime);
    }
    return this.logged(
      "Query",
      name,
      caller,
      () => this.engine.queryJson(this.queryBody(name, args, false, caller, f), undefined, undefined, caller),
      returnedJson,
      args,
    );
  }

  /**
   * A room's gate (AD-42, STUDY-164 §3.4): run as a query named `name` (`rooms:doc#canJoin`) with `caller`'s identity, read-only and
   * without the query cache, as a standalone query runs. Its value, or what it threw. Not a function: no
   * client can call it by path.
   */
  async runGate(gate: RoomGate, name: string, args: Value, caller: Caller): Promise<unknown> {
    // A query of its own per run, so that runs at once (one gate in two rooms) each keep their name. No args
    // validator: the room's were checked at join.
    const f: QueryDef = { kind: "query", visibility: "internal", handler: (ctx, a) => gate(ctx as never, a) };
    // A sandboxed version's gate runs in its child, as its queries do.
    const remote = REMOTE_GATES.get(gate);
    if (remote) REMOTE_FUNCTIONS.set(f as FunctionDef, remote);
    this.names.set(f, registryKey(name));
    return this.logged(
      "Query",
      name,
      caller,
      () => this.engine.query(this.queryBody(name, args, false, caller, f), undefined, undefined, caller),
      returned,
      args,
    );
  }

  /**
   * A query at snapshot `ts` (≤ the visible ts), as JSON: the HTTP API's `query_at_ts`. Through the query
   * cache, as in Convex: a result cached at or before `ts` and still valid at `ts` answers it.
   */
  async runQueryAtJson(name: string, args: unknown, ts: bigint, caller?: Caller): Promise<string> {
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
  ): Promise<{ value: unknown; ts: bigint }> {
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
  ): Promise<{ ts: bigint } & ({ value: unknown } | { replayed: SessionRequestOutcome })> {
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
    return this.logged("Mutation", name, caller, run, (r) => ("value" in r ? returned(r.value) : { skip: true }), args);
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
        // As Convex's runner: a `_system/` path only for an admin or the system (there are no system actions)
        if (isSystemPath(name) && !isSystemIdentity(caller)) throw new SystemIdentityRequiredError("action");
        const f = this.fn(opts.internal ? registryKey(name) : name, "action", !opts.internal, caller);
        // Shared by the action's run and its `ctx`: once it ended, the `ctx` refuses (STUDY-77 §7).
        const life: ActionLife = { ended: false };
        const ctx = this.actionCtx(caller, opts.authError ?? null, opts.job, f, f.handler, undefined, life);
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
                await withActionTimeout(
                  ms,
                  timeout,
                  () => {
                    const run = () =>
                      this.inActionEnv(
                        () =>
                          inHandleScope(
                            {
                              db: null,
                              engine: this.engine,
                              resolve: (ref) => this.resolveCall(ref, this.componentOf.get(f), null, true),
                            },
                            () => f.handler(ctx, a),
                          ),
                        this.componentOf.get(f),
                      );
                    // A Node action's uncaught callback exception or `process.exit` fails it at once (platform §9).
                    return node ? withNodeProcessErrors(run) : run();
                  },
                  // A V8 action ends with its answer, as Convex's isolate (STUDY-77 §7); a Node one runs on.
                  { endsWithAnswer: !node, life },
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
      args,
    );
  }

  /**
   * An action's context. `authError`: the request's token failed verification (an HTTP action still runs,
   * as in Convex): `getUserIdentity()` throws it, and the queries and mutations it calls run with no identity.
   * The actions it calls get the error too, as Convex passes them the same identity (STUDY-66 §5).
   */
  private actionCtx(
    caller: Caller | undefined,
    authError: Error | null,
    job?: string,
    f?: FunctionDef,
    handler: unknown = f?.handler,
    /** An HTTP action's component (STUDY-157): the one its route reached. */
    httpComponent?: ComponentRuntime,
    /** Whether the action has ended: its `ctx` then refuses (V8 actions only). */
    life?: ActionLife,
  ): ActionCtx {
    const identity = (caller?.identity ?? null) as UserIdentity | null;
    // A component's action calls its own component's functions by name (STUDY-154); other components are step 5.
    const component = httpComponent ?? (f ? this.componentOf.get(f) : undefined);
    // What the action calls (STUDY-155): its own component's functions by name, its children's public exports by
    // reference, a handle's function.
    const target = async (ref: FunctionRef) => {
      const t = await this.resolveCall(ref, component, null, true);
      return splitComponentFunctionName(t) ? t : actionTarget(t);
    };
    // Convex's `propagate_component_auth`: a user's identity crosses only from the app to the app (an admin has none,
    // and one acting as a user is that user there); its admin access stays.
    const callerOf = (t: string): Caller | undefined => {
      const crossing = component !== undefined || splitComponentFunctionName(t) !== null;
      return crossing && caller ? { ...caller, identity: null } : caller;
    };
    // Pushed code's handler: its context's wrapper for nested calls (`installNestedCalls`).
    const nestedCalls = (handler as { [NESTED_CALLS]?: NestedCalls } | undefined)?.[NESTED_CALLS];
    const inContext = nestedCalls !== undefined;
    const r = roomsCtx(this, null, true);
    const ctx = trackedCtx({
      auth: {
        getUserIdentity: async () => {
          if (authError) throw authError;
          return copy(identity);
        },
      },
      // Once the action timed out, nothing it calls starts (STUDY-77).
      runQuery: async (n: FunctionRef, a?: unknown) => {
        checkActionAlive();
        checkActionCallArgs(n, a);
        const t = await target(n);
        return acrossCall(await asActionCaller(this.runQuery(t, acrossArgs(a), false, callerOf(t)), inContext));
      },
      runMutation: async (n: FunctionRef, a?: unknown) => {
        checkActionAlive();
        checkActionCallArgs(n, a);
        const t = await target(n);
        return acrossCall(await asActionCaller(this.runMutation(t, acrossArgs(a), false, callerOf(t)), inContext));
      },
      runAction: async (n: FunctionRef, a?: unknown) => {
        checkActionAlive();
        checkActionCallArgs(n, a);
        const t = await target(n);
        return acrossCall(
          await asActionCaller(
            this.runAction(t, acrossArgs(a), callerOf(t), {
              internal: true,
              authError,
            }),
            inContext,
          ),
        );
      },
      // As a mutation's: the job also reaches an action that a scheduled action ran.
      scheduler: cutOffWithAction(
        makeScheduler(this, {
          engine: this.engine,
          component,
          // Convex's action scheduler sends its request id first (an HTTP action's is "").
          requestId: f === HTTP_ACTION ? "" : (caller?.request?.requestId ?? ""),
          systemIdentity: isSystemIdentity(caller),
          job: job ?? caller?.request?.scheduledFunctionId ?? undefined,
          jobComponent: caller?.request?.scheduledFunctionComponent ?? null,
        }),
      ),
      storage: cutOffWithAction(this.fileStorage?.actionWriter(storageMeter, component?.id ?? null) ?? noStorage),
      rooms: cutOffWithAction(r.rooms),
      presence: cutOffWithAction(r.presence as NonNullable<typeof r.presence>),
      vectorSearch: async (
        tableName: string,
        indexName: string,
        query: VectorSearchQuery<GenericTableInfo, string>,
      ) => {
        checkActionAlive();
        const filter = vectorSearchFilter(tableName, indexName, query);
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
            // A component's action searches its own tables (Convex's `insert_component_id`, STUDY-157).
            component?.id ?? null,
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
    // Once the action ended, its `ctx` refuses, whoever calls it (STUDY-77 §7).
    if (life) endsWith(ctx, life);
    if (!nestedCalls) return ctx;
    return appContext(handler, {
      ...ctx,
      runQuery: nestedCalls(ctx.runQuery, fromNestedCall),
      runMutation: nestedCalls(ctx.runMutation, fromNestedCall),
      runAction: nestedCalls(ctx.runAction, fromNestedCall),
    });
  }

  /** @internal Run an HTTP action's handler with an action's context, holding an action permit. */
  runHttpAction(
    handler: (ctx: ActionCtx, request: Request) => Promise<Response> | Response,
    request: Request,
    caller: Caller,
    authError: Error | null,
    /** The route the router matched (a prefix route's path ends in `*`); null for none. */
    route: { method: RoutableMethod; path: string } | null = null,
    /** The component the request was routed to (STUDY-157); the app's when absent. */
    component?: ComponentRuntime,
  ): Promise<Response> {
    // In a component, a user's identity does not cross (Convex's `propagate_component_auth`, the component both
    // caller and callee): no identity, and no token error to throw; an admin's stays.
    if (component && !isSystemIdentity(caller)) {
      caller = { ...caller, identity: null };
      authError = null;
    }
    // The action's life (STUDY-77 §7): it ends once its body has been handed over (or it failed), as Convex's isolate
    // runs until the response's stream ends and then shuts its tasks down (`environment/action/mod.rs` `run_inner`):
    // the timers its code left are cleared, and a `ctx` it kept refuses.
    const life: ActionLife = { ended: false };
    let end = () => {
      life.ended = true;
    };
    const ctx = this.actionCtx(caller, authError, undefined, HTTP_ACTION, handler, component, life);
    let t0 = 0;
    let running: Running | null = null;
    let body: { sent: Promise<SentBody> } | null = null;
    // Convex's HTTP action warnings (STUDY-76), when its response is sent or its handler failed.
    const warnings = (sentBytes: number, tooLarge = false) =>
      httpActionWarnings({
        sentBytes,
        tooLarge,
        limitBytes: HTTP_ACTION_RESPONSE_LIMIT,
        pending: running?.pendingOps ?? new Map(),
        elapsedMs: performance.now() - t0,
      });
    // Named as Convex's `HttpActionRoute` (`<METHOD> <path>`, HEAD as GET): its lines by the request
    // (`route_for_failure`), its Completion by the route matched, once it ran to the end (STUDY-31 §7).
    const requested = `${request.method === "HEAD" ? "GET" : request.method} ${new URL(request.url).pathname}`;
    let logged: Outcome = {};
    return this.logged(
      "HttpAction",
      requested,
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
                this.inActionEnv(
                  () =>
                    inHandleScope(
                      {
                        db: null,
                        engine: this.engine,
                        // A component's handles resolve from it (STUDY-155).
                        ...(component && { resolve: (ref: unknown) => this.resolveCall(ref, component, null, true) }),
                      },
                      () => handler(ctx, trackedFormData(request)),
                    ),
                  component,
                ),
              {
                life,
                endsLater: (e) => {
                  end = e;
                },
              },
            );
            // Convex's router checks the result (`convexJsonFromResponse`): a failure before the head, logged with
            // its error and answered with the 500.
            if (!(response instanceof Response)) throw new Error("HTTP actions must return a Response");
            // The headers before the body: Bun adds a Blob body's Content-Type (`new Response(blob)`) only if
            // they are read first.
            const headers = response.headers;
            if (!response.body) {
              end();
              warnings(0);
              return response;
            }
            const init = { status: response.status, statusText: response.statusText, headers };
            let stream = response.body;
            // A body of known length (not a stream) is sent with its `content-length` unless the app set one, as
            // Convex's (STUDY-31 §8); Bun sends a stream chunked. Convex's isolate hands such a body over at once,
            // so the run is logged now.
            const length = response.bodyUsed ? undefined : bodyLength(response);
            if (length !== undefined && headers.has("content-type")) {
              const whole = await response.blob();
              if (whole.size <= HTTP_ACTION_RESPONSE_LIMIT) {
                if (!headers.has("content-length")) headers.set("content-length", String(whole.size));
                body = {
                  sent: Promise.resolve({ bytes: whole.size, errors: [], tooLarge: false, disconnected: false }),
                };
                end();
                return new Response(whole, init);
              }
              stream = whole.stream();
            } else if (typeof length === "number" && request.method === "HEAD") {
              // Untyped bytes: Bun would type a whole body (`application/octet-stream`), so they are streamed, with
              // the length only when Bun has them at once (DV-483); a HEAD request gets it.
              if (!headers.has("content-length")) headers.set("content-length", String(length));
            }
            // The body, sent as Convex's streamer does (100 MiB at most); the run is logged once it is.
            const metered = meteredBody(stream, request.signal);
            // A stream that failed before the head would go fails the run, as a throw (STUDY-31 §10).
            if (length === undefined) {
              const early = await metered.failedEarly();
              if (early) throw early.error;
            }
            body = metered;
            // The body's code runs on while it streams (its pulls, its `ctx`); the action ends when it has been handed
            // over: its end, its failure, or its client gone.
            void metered.sent.then(() => end());
            return new Response(metered.stream, init);
          } catch (e) {
            end();
            if (!isSystemError(e)) warnings(0);
            throw e;
          }
        });
      },
      // The handler ran to the end, but its client left before the head could be sent: as Convex, the
      // execution is logged as failed with "Client disconnected" (its writes stay).
      (r) =>
        (logged = request.signal.aborted
          ? { error: new ClientDisconnectedError() }
          : {
              success: { status: String(r.status) },
              ...(route && { route: { identifier: `${route.method} ${route.path}`, metricsName: route.path } }),
            }),
      undefined,
      () =>
        body &&
        body.sent.then(({ bytes, errors, tooLarge, disconnected }) => () => {
          // A body that failed or lost its client ends the run as Convex's failed one: under the request.
          if (errors.length > 0 || disconnected) delete logged.route;
          for (const e of errors) logSystemLine("ERROR", e, "error:httpAction");
          // The client left mid-body: Convex stops the run there and ends its lines with an INFO line (no
          // more lines or response parts will come); its run is still logged with the head's status.
          if (disconnected) logSystemLine("INFO", "Client disconnected", "info:httpActionClientDisconnect");
          else warnings(bytes, tooLarge);
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
