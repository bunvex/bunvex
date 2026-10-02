// The function runtime: query / mutation / action definitions (a handler, or `{ args, returns, handler }`
// with validators, as Convex — STUDY-13), the registry that names them ("module:fn"), internal functions,
// and the calls the transports make. Transactions themselves run in
// the engine (@bunvex/core); this layer only decides WHICH body runs and with what context.
import type { UserIdentity } from "@bunvex/auth";
import {
  type Caller,
  type Engine,
  type SessionRequestId,
  type SessionRequestOutcome,
  stringifyValue,
  type Tx,
} from "@bunvex/core";
import { type AnyFunctionReference, getFunctionName } from "@bunvex/protocol";
import {
  checkValue,
  displayValue,
  type GenericValidator,
  type Infer,
  isSimpleObject,
  type ObjectType,
  type PropertyValidators,
  type Value,
  v,
} from "@bunvex/values";
import { ActionPermits } from "./action-permits.ts";
import { FunctionPathError } from "./errors.ts";
import { cachedQueryLogs, currentLogLines, perAttempt } from "./logs.ts";
import { makeScheduler, type Scheduler } from "./scheduler.ts";
import { SYSTEM_QUERIES } from "./system-functions.ts";

/** The query cache key: function name + the args' canonical Convex JSON (fields sorted, bigint safe). */
const cacheKey = (name: string, args: unknown) => `${name}\u0000${stringifyValue(args ?? {})}`;

/** A function name as the registry keys it: `module:function`, `.js` stripped, `default` when unnamed. */
const registryKey = (name: string) => {
  const i = name.lastIndexOf(":");
  const [module, fn] = i === -1 ? [name, "default"] : [name.slice(0, i), name.slice(i + 1)];
  return `${module.endsWith(".js") ? module.slice(0, -3) : module}:${fn}`;
};

/** `ctx.auth` (STUDY-27): the caller's identity, or null without a (valid) token. */
export type Auth = { getUserIdentity(): Promise<UserIdentity | null> };
export type QueryCtx = { db: Tx; auth: Auth };
export type MutationCtx = { db: Tx; auth: Auth; scheduler: Scheduler };
/** A function to call from an action: a reference (`api.module.fn`, `internal.module.fn`) or its name. */
export type FunctionRef = AnyFunctionReference | string;
export type ActionCtx = {
  auth: Auth;
  runQuery: (fn: FunctionRef, args?: unknown) => Promise<unknown>;
  runMutation: (fn: FunctionRef, args?: unknown) => Promise<unknown>;
  runAction: (fn: FunctionRef, args?: unknown) => Promise<unknown>;
  scheduler: Scheduler;
};

/** Who calls (STUDY-27): the identity, and its canonical JSON for the query cache's per-user entries. */
export const callerOf = (identity: UserIdentity | null): Caller =>
  identity === null ? { identity: null, key: "" } : { identity, key: stringifyValue(identity) };
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

function define<K extends FunctionDef["kind"]>(kind: K, visibility: Visibility, def: unknown): FunctionDef {
  if (typeof def === "function") return { kind, visibility, handler: def } as FunctionDef;
  const d = def as { args?: ArgsValidator; returns?: GenericValidator; handler: unknown };
  if (typeof d?.handler !== "function")
    throw new Error(`${kind}(): expected a function or { args?, returns?, handler }`);
  return {
    kind,
    visibility,
    handler: d.handler,
    args: d.args === undefined ? undefined : asObjectValidator(d.args),
    returns: d.returns,
  } as FunctionDef;
}

/** A builder, as Convex's: `{ args, returns, handler }` (types from the validators) or a bare handler. */
export type Builder<Ctx> = {
  <A extends ArgsValidator = AnyArgs, R = unknown>(def: {
    args?: A;
    returns?: GenericValidator;
    handler: (ctx: Ctx, args: ArgsOf<A>) => R;
  }): FunctionDef;
  <Args extends AnyArgs = AnyArgs, R = unknown>(handler: (ctx: Ctx, args: Args) => R): FunctionDef;
};
const builder = <Ctx>(kind: FunctionDef["kind"], visibility: Visibility) =>
  ((def: unknown) => define(kind, visibility, def)) as Builder<Ctx>;

export const query = builder<QueryCtx>("query", "public");
export const internalQuery = builder<QueryCtx>("query", "internal");
export const mutation = builder<MutationCtx>("mutation", "public");
export const internalMutation = builder<MutationCtx>("mutation", "internal");
export const action = builder<ActionCtx>("action", "public");
export const internalAction = builder<ActionCtx>("action", "internal");

export class Functions {
  private fns = new Map<string, FunctionDef>();

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

  private fn<K extends FunctionDef["kind"]>(name: string, kind: K, fromClient: boolean) {
    const f = this.fns.get(name);
    // As Convex (crates/udf/src/validation.rs): a missing function and an internal one called from a
    // client read the same, with the path stripped (no `.js`, no `:default`); a function of another kind
    // names the canonical path (`module.js:name`) and both kinds.
    if (!f || (fromClient && f.visibility === "internal"))
      throw new FunctionPathError(`Could not find public function for '${name.replace(/:default$/, "")}'.`);
    if (f.kind !== kind) {
      const i = name.lastIndexOf(":");
      const kindName = (k: string) => k[0].toUpperCase() + k.slice(1);
      throw new FunctionPathError(
        `Trying to execute ${name.slice(0, i)}.js${name.slice(i)} as ${kindName(kind)}, but it is defined as ${kindName(f.kind)}.`,
      );
    }
    return f as Extract<FunctionDef, { kind: K }>;
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
  queryBody(name: string, args: unknown, fromClient = true) {
    const f = this.fn(name, "query", fromClient);
    return async (db: Tx) => this.checkReturns(f, await f.handler({ db, auth: txAuth(db) }, this.checkArgs(f, args)));
  }

  /**
   * The body a mutation runs: per attempt, so a retried run's console lines replace the aborted one's.
   * `job`: the scheduled job it runs as, if any (a mutation cannot cancel its own job).
   */
  private mutationBody(f: FunctionDef & { kind: "mutation" }, args: unknown, job?: string) {
    return perAttempt(async (db: Tx) =>
      this.checkReturns(
        f,
        await f.handler({ db, auth: txAuth(db), scheduler: makeScheduler(this, { db, job }) }, this.checkArgs(f, args)),
      ),
    );
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
   * A dashboard system query (`_system/frontend/*`, system-functions.ts), as an admin: Convex's names,
   * argument checks and result shapes. Not reachable from clients (no `_system` name is public).
   */
  async runSystemQuery(name: string, args: unknown = {}): Promise<unknown> {
    const q = SYSTEM_QUERIES[name.replace(/:default$/, "")];
    if (!q) throw new FunctionPathError(`Could not find public function for '${name.replace(/:default$/, "")}'.`);
    const a = args ?? {};
    if (!isSimpleObject(a))
      throw new Error(`ArgumentValidationError: Arguments must be an object, got ${displayValue(a as Value)}.`);
    const msg = checkValue(v.object(q.args), a as Value, this.tableOf);
    if (msg) throw new Error(`ArgumentValidationError: ${msg}`);
    return this.engine.query((db) => q.handler(db, a as never));
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
    return this.engine.query(this.queryBody(name, args, fromClient), cacheKey(name, args), cachedQueryLogs, caller);
  }
  /** A query's result as JSON, for the HTTP API (a cache hit is sent as stored, with its log lines). */
  async runQueryJson(name: string, args: unknown, caller?: Caller): Promise<string> {
    return this.engine.queryJson(this.queryBody(name, args, true), cacheKey(name, args), cachedQueryLogs, caller);
  }

  /**
   * A query at snapshot `ts` (≤ the visible ts), as JSON: the HTTP API's `query_at_ts`. Through the query
   * cache, as in Convex: a result cached at or before `ts` and still valid at `ts` answers it.
   */
  async runQueryAtJson(name: string, args: unknown, ts: number, caller?: Caller): Promise<string> {
    // As Convex's snapshot manager: a transaction may not begin further back than MAX_TRANSACTION_WINDOW
    // (OutOfRetention, a "try again later" system error). Every other transaction begins at the latest ts.
    this.engine.committer.checkBeginTs(ts);
    const body = this.queryBody(name, args, true);
    return this.engine.queryJson(body, cacheKey(name, args), cachedQueryLogs, caller, ts);
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
    const f = this.fn(name, "mutation", fromClient);
    // The name is the write source other mutations' OCC errors cite (STUDY-21).
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
    const f = this.fn(name, "mutation", true);
    return this.engine.sessionMutation(
      this.mutationBody(f, args),
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
    const f = this.fn(opts.internal ? registryKey(name) : name, "action", !opts.internal);
    const ctx = this.actionCtx(caller, null, opts.job);
    const a = this.checkArgs(f, args);
    return this.actionPermits.run(() => Promise.resolve(f.handler(ctx, a)).then((r) => this.checkReturns(f, r)));
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
      runQuery: (n, a) => this.runQuery(registryKey(getFunctionName(n)), a, false, caller),
      runMutation: (n, a) => this.runMutation(registryKey(getFunctionName(n)), a, false, caller),
      runAction: (n, a) => this.runAction(getFunctionName(n), a, caller, { internal: true }),
      scheduler: makeScheduler(this, { engine: this.engine, job }),
    };
  }

  /** @internal Run an HTTP action's handler with an action's context, holding an action permit. */
  runHttpAction(
    handler: (ctx: ActionCtx, request: Request) => Promise<Response> | Response,
    request: Request,
    caller: Caller,
    authError: Error | null,
  ): Promise<unknown> {
    const ctx = this.actionCtx(caller, authError);
    return this.actionPermits.run(async () => handler(ctx, request));
  }
}
