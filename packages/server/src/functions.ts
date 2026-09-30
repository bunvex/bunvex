// The function runtime: query / mutation / action definitions (a handler, or `{ args, returns, handler }`
// with validators, as Convex — STUDY-13), the registry that names them ("module:fn"), internal functions,
// and the calls the transports make. Transactions themselves run in
// the engine (@bunvex/core); this layer only decides WHICH body runs and with what context.
import { type Engine, stringifyValue, type Tx } from "@bunvex/core";
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
import { perAttempt } from "./logs.ts";

/** The query cache key: function name + the args' canonical Convex JSON (fields sorted, bigint safe). */
const cacheKey = (name: string, args: unknown) => `${name}\u0000${stringifyValue(args ?? {})}`;

export type QueryCtx = { db: Tx };
export type MutationCtx = { db: Tx };
export type ActionCtx = {
  runQuery: (name: string, args?: unknown) => Promise<unknown>;
  runMutation: (name: string, args?: unknown) => Promise<unknown>;
};

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

  constructor(private engine: Engine) {}

  register(module: string, fns: Record<string, FunctionDef>) {
    for (const [n, f] of Object.entries(fns)) this.fns.set(`${module}:${n}`, f);
    return this;
  }

  private fn<K extends FunctionDef["kind"]>(name: string, kind: K, fromClient: boolean) {
    const f = this.fns.get(name);
    if (!f || f.kind !== kind || (fromClient && f.visibility === "internal"))
      throw new Error(`function not found: ${name}`);
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
    return async (db: Tx) => this.checkReturns(f, await f.handler({ db }, this.checkArgs(f, args)));
  }

  async runQuery(name: string, args: unknown, fromClient = true): Promise<unknown> {
    return this.engine.query(this.queryBody(name, args, fromClient), cacheKey(name, args));
  }
  /** A query's result as JSON, for the HTTP API (a cache hit is sent as stored). */
  async runQueryJson(name: string, args: unknown): Promise<string> {
    return this.engine.queryJson(this.queryBody(name, args, true), cacheKey(name, args));
  }

  async runMutation(name: string, args: unknown, fromClient = true): Promise<unknown> {
    const f = this.fn(name, "mutation", fromClient);
    // perAttempt: a retried run's console lines replace the aborted attempt's (logs.ts).
    return this.engine.mutation(
      perAttempt(async (db) => this.checkReturns(f, await f.handler({ db }, this.checkArgs(f, args)))),
    );
  }

  async runAction(name: string, args: unknown): Promise<unknown> {
    const f = this.fn(name, "action", true);
    const ctx: ActionCtx = {
      runQuery: (n, a) => this.runQuery(n, a, false),
      runMutation: (n, a) => this.runMutation(n, a, false),
    };
    const a = this.checkArgs(f, args);
    return Promise.resolve(f.handler(ctx, a)).then((r) => this.checkReturns(f, r));
  }
}
