// The function runtime: query / mutation / action definitions, the registry that names them
// ("module:fn"), internal functions, and the calls the transports make. Transactions themselves run in
// the engine (@bunvex/core); this layer only decides WHICH body runs and with what context.
import { type Engine, type Tx, valueToJson } from "@bunvex/core";

/** The query cache key: function name + the args' canonical Convex JSON (fields sorted, bigint safe). */
const cacheKey = (name: string, args: unknown) => `${name}\u0000${valueToJson(args ?? {})}`;

export type QueryCtx = { db: Tx };
export type MutationCtx = { db: Tx };
export type ActionCtx = {
  runQuery: (name: string, args: unknown) => Promise<unknown>;
  runMutation: (name: string, args: unknown) => Promise<unknown>;
};

// biome-ignore lint/suspicious/noExplicitAny: argument validation (values) is an ARCHITECTURE.md "N" item
type Args = any;
export type FunctionDef =
  | { kind: "query"; internal?: boolean; handler: (ctx: QueryCtx, args: Args) => unknown }
  | { kind: "mutation"; internal?: boolean; handler: (ctx: MutationCtx, args: Args) => unknown }
  | { kind: "action"; internal?: boolean; handler: (ctx: ActionCtx, args: Args) => unknown };

export const query = (handler: (ctx: QueryCtx, args: Args) => unknown, internal = false): FunctionDef => ({
  kind: "query",
  handler,
  internal,
});
export const mutation = (handler: (ctx: MutationCtx, args: Args) => unknown, internal = false): FunctionDef => ({
  kind: "mutation",
  handler,
  internal,
});
export const action = (handler: (ctx: ActionCtx, args: Args) => unknown, internal = false): FunctionDef => ({
  kind: "action",
  handler,
  internal,
});

export class Functions {
  private fns = new Map<string, FunctionDef>();

  constructor(private engine: Engine) {}

  register(module: string, fns: Record<string, FunctionDef>) {
    for (const [n, f] of Object.entries(fns)) this.fns.set(`${module}:${n}`, f);
    return this;
  }

  private fn<K extends FunctionDef["kind"]>(name: string, kind: K, fromClient: boolean) {
    const f = this.fns.get(name);
    if (!f || f.kind !== kind || (fromClient && f.internal)) throw new Error(`function not found: ${name}`);
    return f as Extract<FunctionDef, { kind: K }>;
  }

  /** The body a query runs, for the transports that manage their own transaction (subscriptions). */
  queryBody(name: string, args: unknown, fromClient = true) {
    const f = this.fn(name, "query", fromClient);
    return (db: Tx) => f.handler({ db }, args ?? {});
  }

  runQuery(name: string, args: unknown, fromClient = true): Promise<unknown> {
    return this.engine.query(this.queryBody(name, args, fromClient), cacheKey(name, args));
  }
  /** A query's result as JSON, for the HTTP API (a cache hit is sent as stored). */
  runQueryJson(name: string, args: unknown): Promise<string> {
    return this.engine.queryJson(this.queryBody(name, args, true), cacheKey(name, args));
  }

  runMutation(name: string, args: unknown, fromClient = true): Promise<unknown> {
    const f = this.fn(name, "mutation", fromClient);
    return this.engine.mutation((db) => f.handler({ db }, args ?? {}));
  }

  runAction(name: string, args: unknown): Promise<unknown> {
    const f = this.fn(name, "action", true);
    const ctx: ActionCtx = {
      runQuery: (n, a) => this.runQuery(n, a, false),
      runMutation: (n, a) => this.runMutation(n, a, false),
    };
    return Promise.resolve(f.handler(ctx, args ?? {}));
  }
}
