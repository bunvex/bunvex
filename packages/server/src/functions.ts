// The function runtime: query / mutation / action definitions (a handler, or `{ args, returns, handler }`
// with validators, as Convex — STUDY-13), the registry that names them ("module:fn"), internal functions,
// and the calls the transports make. Transactions themselves run in
// the engine (@bunvex/core); this layer only decides WHICH body runs and with what context.
import type { UserIdentity } from "@bunvex/auth";
import {
  type Caller,
  checkEnvVarName,
  type Engine,
  newUserTimer,
  pausingUserTime,
  type SessionRequestId,
  type SessionRequestOutcome,
  stringifyValue,
  type Tx,
  withUserTimer,
} from "@bunvex/core";
import { type AnyFunctionReference, getFunctionName } from "@bunvex/protocol";
import {
  BunvexError,
  checkValue,
  displayValue,
  type GenericValidator,
  type Infer,
  isBunvexError,
  isSimpleObject,
  type ObjectType,
  type PropertyValidators,
  type Value,
  v,
} from "@bunvex/values";
import { ActionPermits } from "./action-permits.ts";
import {
  type AdminKeyIdentity,
  allows,
  BadDeployKeyError,
  type DeploymentOp,
  OperationNotPermittedError,
} from "./admin-keys.ts";
import { type EnvReader, withAllEnv, withEnv } from "./env-scope.ts";
import { FunctionPathError } from "./errors.ts";
import { cachedQueryLogs, currentLogLines, perAttempt } from "./logs.ts";
import type {
  ActionBuilder,
  GenericActionCtx,
  GenericMutationCtx,
  GenericQueryCtx,
  MutationBuilder,
  QueryBuilder,
} from "./registration.ts";
import { makeScheduler, type Scheduler } from "./scheduler.ts";
import type { FileStorage } from "./storage.ts";
import { SYSTEM_MUTATIONS, SYSTEM_QUERIES, type SystemQuery } from "./system-functions.ts";

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
 * A nested call's error as its caller sees it (Convex's `performAsyncSyscall`): a new `Error` with the
 * message, or a `BunvexError` with the data (STUDY-41 N2: without Convex's appended stack text).
 */
function toCallerError(e: unknown): Error {
  if (isBunvexError(e)) return new BunvexError(e.data);
  return new Error(e instanceof Error ? e.message : String(e));
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

/** `args`: an object of field validators or a validator (Convex's `asObjectValidator`). */
export type ArgsValidator = PropertyValidators | GenericValidator;
// biome-ignore lint/suspicious/noExplicitAny: without an `args` validator the arguments are any object
type AnyArgs = Record<string, any>;
export type ArgsOf<A> = A extends { isValidator: true }
  ? Infer<A & GenericValidator>
  : A extends PropertyValidators
    ? ObjectType<A>
    : AnyArgs;

export type Visibility = "public" | "internal";
type Handler<Ctx> = (ctx: Ctx, args: AnyArgs) => unknown;
export type FunctionDef =
  | {
      kind: "query";
      visibility: Visibility;
      handler: Handler<QueryCtx>;
      args?: GenericValidator;
      returns?: GenericValidator;
    }
  | {
      kind: "mutation";
      visibility: Visibility;
      handler: Handler<MutationCtx>;
      args?: GenericValidator;
      returns?: GenericValidator;
    }
  | {
      kind: "action";
      visibility: Visibility;
      handler: Handler<ActionCtx>;
      args?: GenericValidator;
      returns?: GenericValidator;
    };

const asObjectValidator = (a: ArgsValidator): GenericValidator =>
  (a as GenericValidator).isValidator ? (a as GenericValidator) : v.object(a as PropertyValidators);

/** Every function a builder made: how a code version's analysis tells its functions from other exports. */
const DEFINED = new WeakSet<object>();
export const isFunctionDef = (x: unknown): x is FunctionDef => typeof x === "object" && x !== null && DEFINED.has(x);

const KIND_MARKER = { query: "isQuery", mutation: "isMutation", action: "isAction" } as const;

function define<K extends FunctionDef["kind"]>(kind: K, visibility: Visibility, def: unknown): FunctionDef {
  const f = defineUnmarked(kind, visibility, def);
  // Convex's markers: what the function is (`ApiFromModules` reads them as types).
  Object.assign(f, {
    isBunvexFunction: true,
    [KIND_MARKER[kind]]: true,
    [visibility === "public" ? "isPublic" : "isInternal"]: true,
  });
  DEFINED.add(f);
  return f;
}

function defineUnmarked<K extends FunctionDef["kind"]>(kind: K, visibility: Visibility, def: unknown): FunctionDef {
  if (typeof def === "function") return { kind, visibility, handler: def } as FunctionDef;
  const d = def as { args?: ArgsValidator; returns?: ArgsValidator; handler: unknown };
  if (typeof d?.handler !== "function")
    throw new Error(`${kind}(): expected a function or { args?, returns?, handler }`);
  return {
    kind,
    visibility,
    handler: d.handler,
    args: d.args === undefined ? undefined : asObjectValidator(d.args),
    // An object of field validators is `v.object` of them, for `returns` as for `args` (Convex's
    // `asObjectValidator`).
    returns: d.returns === undefined ? undefined : asObjectValidator(d.returns),
  } as FunctionDef;
}

// The builders without a data model, as Convex's `queryGeneric` …; `_generated/server` re-exports them
// typed with the app's data model. `query` … are the same builders, for apps without codegen.
const builder = (kind: FunctionDef["kind"], visibility: Visibility) => (def: unknown) => define(kind, visibility, def);

// biome-ignore lint/suspicious/noExplicitAny: no data model
type AnyDM = any;
export const queryGeneric = builder("query", "public") as unknown as QueryBuilder<AnyDM, "public">;
export const internalQueryGeneric = builder("query", "internal") as unknown as QueryBuilder<AnyDM, "internal">;
export const mutationGeneric = builder("mutation", "public") as unknown as MutationBuilder<AnyDM, "public">;
export const internalMutationGeneric = builder("mutation", "internal") as unknown as MutationBuilder<AnyDM, "internal">;
export const actionGeneric = builder("action", "public") as unknown as ActionBuilder<AnyDM, "public">;
export const internalActionGeneric = builder("action", "internal") as unknown as ActionBuilder<AnyDM, "internal">;
export const query = queryGeneric;
export const internalQuery = internalQueryGeneric;
export const mutation = mutationGeneric;
export const internalMutation = internalMutationGeneric;
export const action = actionGeneric;
export const internalAction = internalActionGeneric;

export class Functions {
  private fns = new Map<string, FunctionDef>();
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

  /** A query's or mutation's `process.env`: each read in `db`'s read set. */
  private async txEnv(db: Tx): Promise<EnvReader | null> {
    if (!this.deployed) return null;
    const read = await this.engine.environment.reader(db);
    return (name) => read(name) ?? this.builtinEnv[name];
  }

  /** An action's `process.env`: the variables at its start (Convex's `get_all`, no reactivity). */
  private async actionEnv(): Promise<{ all: Record<string, string>; read: EnvReader } | null> {
    if (!this.deployed) return null;
    const vars = await this.engine.query((db) => this.engine.environment.snapshot(db));
    const all = { ...this.builtinEnv, ...Object.fromEntries(vars) };
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

  /** Where files go (STUDY-32); set by `createServer`. */
  fileStorage: FileStorage | null = null;

  /** How many actions run at once (STUDY-31): every action, HTTP actions included, takes a permit. */
  readonly actionPermits: ActionPermits;

  constructor(
    private engine: Engine,
    opts: { actionPermits?: ActionPermits } = {},
  ) {
    this.actionPermits = opts.actionPermits ?? ActionPermits.fromEnv();
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
    const f = this.fns.get(name) ?? this.fns.get(registryKey(name));
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

  /** Convex's `_system/cli/modules:apiSpec`: every function, its kind, visibility and validators. */
  apiSpec() {
    const kind = { query: "Query", mutation: "Mutation", action: "Action" } as const;
    return [...this.fns].map(([key, f]) => {
      const i = key.lastIndexOf(":");
      return {
        identifier: `${key.slice(0, i)}.js:${key.slice(i + 1)}`,
        functionType: kind[f.kind],
        visibility: { kind: f.visibility },
        args: (f.args?.json ?? { type: "any" }) as unknown as Value,
        returns: (f.returns?.json ?? { type: "any" }) as unknown as Value,
      };
    });
  }

  /** An id's table, for `v.id` (the engine's catalog). */
  private tableOf = (n: number) => this.engine.catalog.byNumber(n)?.name;

  /** Arguments are an object, checked against `args` when the function declares it (Convex's rules). */
  private checkArgs(f: FunctionDef, args: unknown): AnyArgs {
    const a = args ?? {};
    if (!isSimpleObject(a))
      throw new Error(`ArgumentValidationError: Arguments must be an object, got ${displayValue(a as Value)}.`);
    if (f.args) {
      const msg = checkValue(f.args, a as Value, this.tableOf);
      if (msg) throw new Error(`ArgumentValidationError: ${msg}`);
    }
    return a as AnyArgs;
  }

  /** The result, checked against `returns` when declared (`undefined` is null, as in Convex). */
  private checkReturns(f: FunctionDef, value: unknown) {
    if (f.returns) {
      const msg = checkValue(f.returns, (value ?? null) as Value, this.tableOf);
      if (msg) throw new Error(`ReturnsValidationError: ${msg}`);
    }
    return value;
  }

  /** The body a query runs, for the transports that manage their own transaction (subscriptions). */
  queryBody(name: string, args: unknown, fromClient = true, caller?: Caller) {
    if (isSystemPath(name)) return this.systemQueryBody(name, args, fromClient, caller);
    const f = this.fn(name, "query", fromClient, caller);
    return async (db: Tx) => {
      const a = this.checkArgs(f, args);
      const env = await this.txEnv(db);
      const run = () => withUserTimer(this.newTimer(), () => this.invoke(f, db, a, 0));
      return this.checkReturns(f, await (env ? withEnv(env, run) : run()));
    };
  }

  /**
   * The body a mutation runs: per attempt, so a retried run's console lines replace the aborted one's.
   * `job`: the scheduled job it runs as, if any (a mutation cannot cancel its own job).
   */
  private mutationBody(f: FunctionDef & { kind: "mutation" }, args: unknown, job?: string) {
    return perAttempt(async (db: Tx) => {
      const a = this.checkArgs(f, args);
      const env = await this.txEnv(db);
      const run = () => withUserTimer(this.newTimer(), () => this.invoke(f, db, a, 0, job));
      return this.checkReturns(f, await (env ? withEnv(env, run) : run()));
    });
  }

  /**
   * Convex's limits on a query's or mutation's own time (STUDY-41): 1 s of user time
   * (DATABASE_UDF_USER_TIMEOUT_SECONDS) and 15 s awaiting the store (DATABASE_UDF_SYSTEM_TIMEOUT_SECONDS).
   * Each nested call gets its own; the caller's clock is paused during it.
   */
  userTimeoutMs = Number(process.env.DATABASE_UDF_USER_TIMEOUT_SECONDS ?? 1) * 1000;
  systemTimeoutMs = Number(process.env.DATABASE_UDF_SYSTEM_TIMEOUT_SECONDS ?? 15) * 1000;
  private newTimer = () => newUserTimer(this.userTimeoutMs, this.systemTimeoutMs);

  /** Run a query's or mutation's handler on `db` at nesting `depth`, with its context. */
  private invoke(f: FunctionDef, db: Tx, args: AnyArgs, depth: number, job?: string): unknown {
    const nested = this.nestedCalls(db, f.kind as "query" | "mutation", depth);
    const ctx =
      f.kind === "query"
        ? {
            db: db as unknown as QueryCtx["db"],
            auth: txAuth(db),
            storage: this.fileStorage?.reader(db) ?? noStorage,
            runQuery: nested.runQuery,
          }
        : {
            db: db as unknown as MutationCtx["db"],
            auth: txAuth(db),
            scheduler: makeScheduler(this, { db, job }),
            storage: this.fileStorage?.writer(db) ?? noStorage,
            runQuery: nested.runQuery,
            runMutation: nested.runMutation,
          };
    return (f.handler as (ctx: unknown, args: AnyArgs) => unknown)(ctx, args);
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
      const run = queue.then(() => pausingUserTime(() => this.runNested(db, kind, ref, args, opts, depth)));
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
    const name = registryKey(getFunctionName(ref));
    const f = this.fn(name, kind, false);
    const a = this.checkArgs(f, args === undefined ? {} : args);
    if (depth >= MAX_NESTED_CALL_DEPTH)
      throw new Error("Cross component call depth limit exceeded. Do you have an infinite loop in your app?");
    if (opts?.useStaleSnapshot) {
      const caller: Caller = { identity: db.identity, key: "" };
      const value = await this.engine.query(
        (stale) => {
          stale.identity = db.identity;
          return this.withLimits(stale, opts.transactionLimits, () =>
            withUserTimer(this.newTimer(), () => this.invoke(f, stale, a, depth + 1)),
          );
        },
        undefined,
        undefined,
        caller,
        db.snapshot,
      );
      return this.checkReturns(f, value);
    }
    const sp = kind === "mutation" ? db.begin() : null;
    let value: unknown;
    try {
      value = await this.withLimits(db, opts?.transactionLimits, () =>
        withUserTimer(this.newTimer(), () => this.invoke(f, db, a, depth + 1)),
      );
    } catch (e) {
      if (sp) db.rollback(sp);
      throw toCallerError(e);
    }
    return this.checkReturns(f, value);
  }

  /**
   * Run `fn` with `db`'s limits lowered by `budget` (Convex's `TransactionLimits::from_budget`: each limit
   * becomes the usage so far plus the budget, never above the current one), restored after. Only the limits
   * bunvex counts apply (STUDY-41 N3).
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

  /** A system function's arguments, checked as Convex's validators. */
  private systemArgs(args: Record<string, unknown> | unknown, validators: Record<string, GenericValidator>) {
    const a = args ?? {};
    if (!isSimpleObject(a))
      throw new Error(`ArgumentValidationError: Arguments must be an object, got ${displayValue(a as Value)}.`);
    const msg = checkValue(v.object(validators), a as Value, this.tableOf);
    if (msg) throw new Error(`ArgumentValidationError: ${msg}`);
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
    this.requireOperation(caller, f.op ?? fallback);
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
    return (db: Tx) => q!.handler(db, a, { files: this.fileStorage, functions: this });
  }

  private systemMutationBody(name: string, args: unknown, fromClient: boolean, caller?: Caller) {
    const n = name.replace(/:default$/, "");
    const m = SYSTEM_MUTATIONS[n];
    if (fromClient) this.systemAccess(n, m, "WriteData", caller);
    else if (!m) throw notFound(n);
    const a = this.systemArgs(args, m!.args);
    return (db: Tx) => m!.handler(db, a, { files: this.fileStorage, functions: this });
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
    return this.mutationBody(this.fn(registryKey(canonical), "mutation", false), args, job);
  }

  async runQuery(name: string, args: unknown, fromClient = true, caller?: Caller): Promise<unknown> {
    return this.engine.query(
      this.queryBody(name, args, fromClient, caller),
      this.cacheKey(name, args),
      cachedQueryLogs,
      caller,
    );
  }
  /** A query's result as JSON, for the HTTP API (a cache hit is sent as stored, with its log lines). */
  async runQueryJson(name: string, args: unknown, caller?: Caller): Promise<string> {
    return this.engine.queryJson(
      this.queryBody(name, args, true, caller),
      this.cacheKey(name, args),
      cachedQueryLogs,
      caller,
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
    return this.engine.queryJson(body, this.cacheKey(name, args), cachedQueryLogs, caller, ts);
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
  ): Promise<{ value: unknown; ts: number }> {
    // The name is the write source other mutations' OCC errors cite (STUDY-21).
    if (isSystemPath(name))
      return this.engine.mutationWithTs(this.systemMutationBody(name, args, fromClient, caller), name, caller);
    const f = this.fn(name, "mutation", fromClient, caller);
    return this.engine.mutationWithTs(this.mutationBody(f, args), name, caller);
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
  ): Promise<{ ts: number } & ({ value: unknown } | { replayed: SessionRequestOutcome })> {
    const body = isSystemPath(name)
      ? this.systemMutationBody(name, args, true, caller)
      : this.mutationBody(this.fn(name, "mutation", true, caller), args);
    return this.engine.sessionMutation(
      body,
      name,
      request,
      // Recorded after the handler returns: its result, and the lines of this attempt (logs.ts).
      (value) => ({ result: stringifyValue(value), logLines: currentLogLines() }),
      caller,
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
    opts: { job?: string; internal?: boolean } = {},
  ): Promise<unknown> {
    const f = this.fn(opts.internal ? registryKey(name) : name, "action", !opts.internal, caller);
    const ctx = this.actionCtx(caller, null, opts.job);
    const a = this.checkArgs(f, args);
    return this.actionPermits.run(() => this.inActionEnv(() => f.handler(ctx, a)).then((r) => this.checkReturns(f, r)));
  }

  /**
   * An action's context. `authError`: the request's token failed verification (an HTTP action still runs,
   * as in Convex): `getUserIdentity()` throws it, and the functions it calls run with no identity.
   */
  private actionCtx(caller: Caller | undefined, authError: Error | null, job?: string): ActionCtx {
    const identity = (caller?.identity ?? null) as UserIdentity | null;
    return {
      auth: {
        getUserIdentity: async () => {
          if (authError) throw authError;
          return copy(identity);
        },
      },
      runQuery: (n: FunctionRef, a?: unknown) => this.runQuery(registryKey(getFunctionName(n)), a, false, caller),
      runMutation: (n: FunctionRef, a?: unknown) => this.runMutation(registryKey(getFunctionName(n)), a, false, caller),
      runAction: (n: FunctionRef, a?: unknown) => this.runAction(getFunctionName(n), a, caller, { internal: true }),
      scheduler: makeScheduler(this, { engine: this.engine, job }),
      storage: this.fileStorage?.actionWriter() ?? noStorage,
    } as ActionCtx;
  }

  /** @internal Run an HTTP action's handler with an action's context, holding an action permit. */
  runHttpAction(
    handler: (ctx: ActionCtx, request: Request) => Promise<Response> | Response,
    request: Request,
    caller: Caller,
    authError: Error | null,
  ): Promise<unknown> {
    const ctx = this.actionCtx(caller, authError);
    return this.actionPermits.run(async () => this.inActionEnv(() => handler(ctx, request)));
  }
}
