// `ctx.db` in the child (STUDY-171 §8.4): what a function's code calls, run by the host on its real transaction.
//
// Every read and write is an operation the host runs on the function's own `Tx` (`host-call.ts`), so the read set,
// OCC, the limits and the query cache are the engine's, as under `vm`. What stays here is what `vm` does
// synchronously, at the app's call, before any of that:
//
// - a query's chain (`db.query(t).withIndex(…).filter(…).order(…)`): each link's checks, in `QueryImpl`'s order and
//   words (core `tx.ts`), the app's callbacks (`withIndex`'s range, `filter`'s predicate, `withSearchIndex`'s
//   filter) run here with the engine's own builders, and the index range compiled against the index's fields when
//   the catalog the call carries has the index ready (`compileRange`), so its errors throw at `withIndex`. Each link
//   is reported with the next message, and the host makes the same link on its real chain first (so `db.query` and
//   `withIndex` read what they read under `vm`, once); a query's states (core's `QueryImpl`, STUDY-188 §X9) and
//   the checks of its start (`checkQueryStart`: an index looked up in that catalog, which carries the indexes being
//   built and the text ones), so a start that fails throws from `[Symbol.asyncIterator]()`; the terminal
//   (`collect`, `take`, `first`, `unique`, `paginate`, `count`, an iteration) names the last link, and every check
//   from there on (and every error) is the engine's;
// - `normalizeId`: from the catalog the call carries (each table's number), and the tables this transaction made,
//   which every answer brings;
// - `db.vars`, `db.table(name)`, `db.system`.
//
// The class names are the engine's (`Tx`, `QueryImpl`, `QueryInitializerImpl`): a message that names what the app
// passed by its class (`Tx {…} is not a supported value type`) names the same.
import {
  checkQueryStart,
  compileRange,
  Expression,
  type FilterOperand,
  filterBuilder,
  TxIndexRangeBuilder as IndexRangeBuilder,
  indexUnavailable,
  MAX_QUERY_OPERATORS,
  type QueryStartState,
  TxSearchFilterBuilder as SearchFilterBuilder,
  TableReader,
  TableWriter,
  TOO_MANY_OPERATORS,
  VIRTUAL_INDEXES,
  VIRTUAL_TABLES,
} from "@bunvex/core";
import { commitTsPlaceholder, decodeId } from "@bunvex/values";
import type { WireTable, WireTerminal } from "./protocol.ts";

type FilterBuilder = typeof filterBuilder;

/** What `ctx.db` needs of its call: the operations, the catalog, and the snapshot (for an index's readiness). */
export type DbHost = {
  op(name: string, args: unknown[]): Promise<unknown>;
  /**
   * A link of a query chain (`db.query(t)`, `withIndex`, …), made by the host on its `ctx.db` before the next
   * message, as the engine makes it at the app's call; its id, which the next link or the terminal names.
   */
  link(kind: string, from: number | null, args: unknown[]): number;
  table(name: string): WireTable | undefined;
  snapshot: bigint;
};

/** How the host gives the function its `db` (`invoke`): a query's own transaction, a reader of a mutation's, a writer. */
export type DbShape = "tx" | "reader" | "writer";

// Convex's message for a system table queried outside `db.system` (core `tx.ts`, STUDY-151).
const SYSTEM_TABLE_QUERY = "System tables can only be accessed from db.system.query().";

// Core's states for a query (`tx.ts`, Convex's `QueryImpl`; STUDY-188 §X9).
const PREPARING = 0;
const EXECUTING = 1;
const CLOSED = 2;
const CONSUMED = 3;
type QueryState = typeof PREPARING | typeof EXECUTING | typeof CLOSED | typeof CONSUMED;

/** Core's error for a query that is closed or consumed, in its words for each. */
const closedError = (state: QueryState) =>
  new Error(
    state === CONSUMED
      ? "This query is closed and can't emit any more values."
      : "This query has been chained with another operator and can't be reused.",
  );

type IndexSpec = { table: string; name: string; fields: string[] };

/**
 * A chain's state: what core's `QState` keeps that its synchronous checks read (the operators, the order, the index
 * or search and why its index cannot be read: core's start checks, `checkQueryStart`), and the host's link for it.
 */
type ChainState = QueryStartState & {
  /** The host's link for this object of the chain. */
  query: number;
  /** The table as the catalog has it, when it does (for `compileRange`). */
  t: WireTable | undefined;
  /** `db.query` of a table the catalog does not have (core's `missingTable`): any index of it is not found. */
  missingTable: boolean;
};

/**
 * Index `name` of `t` at `snapshot`, as core `Tx.resolveIndex` finds it: enabled (with its fields), or why it cannot
 * be read (a text index's name, an index being built, none of that name).
 */
function lookupIndex(t: WireTable, name: string, snapshot: bigint): IndexSpec | Error {
  const ix = t.indexes.find((i) => i[0] === name);
  if (!ix && t.search?.includes(name)) return indexUnavailable(t.name, name, "search");
  if (ix && (ix[2] === null || BigInt(ix[2]) <= snapshot)) return { table: t.name, name, fields: ix[1] };
  // An index enabled after this snapshot was still being built at it.
  if (ix) return indexUnavailable(t.name, name, "backfilling");
  const pending = t.pending?.find((p) => p[0] === name);
  if (!pending) return indexUnavailable(t.name, name, "missing");
  return indexUnavailable(t.name, name, pending[1] ? "staged" : "backfilling");
}

/** What a filter's predicate returned, for the host's own `filter`: an expression by its JSON, else the value. */
const predicateResult = (r: unknown) => (r instanceof Expression ? { expr: r.json } : { literal: r });

/** What both stages of a chain share: the host, the table, the link, and how the next link is made. */
export abstract class QueryChain {
  constructor(
    protected readonly host: DbHost,
    protected readonly table: string,
    protected readonly st: ChainState,
  ) {}

  /** The next link (`kind`, `args`: what it does on the host), made by the host on its real chain too. */
  protected derive(change: (next: ChainState) => unknown[], kind: string): QueryImpl {
    const next: ChainState = { ...this.st, ops: [...this.st.ops] };
    const args = change(next);
    next.query = this.host.link(kind, this.st.query, args);
    return new QueryImpl(this.host, this.table, next);
  }

  /** The terminal, run by the host on its own chain (from there, every check and every error is the engine's). */
  protected run(terminal: WireTerminal): Promise<unknown> {
    return this.host.op("db.query", [this.st.query, terminal]);
  }
}

/**
 * Core's `QueryImpl`: its own iterator, through core's states (preparing, executing, closed, consumed; STUDY-188 §X9),
 * each checked here, at the app's call, in core's words. The host's link goes through the same states, as it is
 * given the same calls.
 */
export class QueryImpl extends QueryChain {
  private state: QueryState = PREPARING;
  /** The host's stream of an executing query, opened at its first `next()`. */
  private stream: Promise<number> | null = null;
  /** A `collect` failed after its start: its stream ended (core's `ended`), a `next()` is done. */
  private ended = false;

  /** Core's `takeQuery`. */
  private takeQuery(): void {
    if (this.state !== PREPARING)
      throw new Error("A query can only be chained once and can't be chained after iteration begins.");
    this.state = CLOSED;
  }

  private chain(change: (next: ChainState) => unknown[], kind: string): QueryImpl {
    this.takeQuery();
    return this.derive(change, kind);
  }

  /**
   * Core's `startQuery`: the state's checks, then the start's, here, from the chain and the catalog the call carries
   * (they throw from `[Symbol.asyncIterator]()`, as the engine's); a query whose start failed is still preparing.
   */
  private startQuery(): void {
    if (this.state === EXECUTING) throw new Error("Iteration can only begin on a query once.");
    if (this.state !== PREPARING) throw closedError(this.state);
    checkQueryStart(this.table, this.st);
    this.state = EXECUTING;
  }

  private results(terminal: WireTerminal): Promise<unknown> {
    try {
      this.takeQuery();
    } catch (e) {
      return Promise.reject(e);
    }
    return this.run(terminal);
  }

  order(dir: "asc" | "desc"): QueryImpl {
    // Core takes the query first: a refused `order` leaves it closed.
    return this.chain((n) => {
      if (n.search) throw new Error("Search queries must always be in relevance order. Can not set order manually.");
      if (n.orderSet) throw new Error("Queries may only specify order at most once");
      n.desc = dir === "desc";
      n.orderSet = true;
      return [dir];
    }, "order");
  }

  filter(predicate: (q: FilterBuilder) => unknown): QueryImpl {
    if (typeof predicate !== "function") throw new TypeError("Must provide arg 1 `predicate` to `filter`");
    return this.chain((n) => {
      if (n.ops.length >= MAX_QUERY_OPERATORS) throw new Error(TOO_MANY_OPERATORS);
      const r = predicate(filterBuilder);
      n.ops.push({ filter: r as FilterOperand });
      return [predicateResult(r)];
    }, "filter");
  }

  limit(n: number): QueryImpl {
    if (n === undefined) throw new TypeError("Must provide arg 1 `n` to `limit`");
    return this.chain((next) => {
      next.ops.push({ limit: n });
      return [n];
    }, "limit");
  }

  take(n: number): Promise<unknown> {
    if (n === undefined) throw new TypeError("Must provide arg 1 `n` to `take`");
    if (!Number.isInteger(n) || n < 0) throw new TypeError("Arg 1 `n` to `take` must be a non-negative integer");
    return this.results({ k: "take", n });
  }

  first(): Promise<unknown> {
    return this.results({ k: "first" });
  }

  unique(): Promise<unknown> {
    return this.results({ k: "unique" });
  }

  /**
   * Core's `collect`: an iteration, so it starts the query, and consumes it once it has every document. A query whose
   * start failed is still preparing (core's start throws before it is executing); one that failed after its start
   * (a document its filter cannot evaluate) is still executing, as the host's link is.
   */
  collect(): Promise<unknown> {
    try {
      this.startQuery();
    } catch (e) {
      return Promise.reject(e);
    }
    return this.run({ k: "collect" }).then(
      (docs) => {
        this.state = CONSUMED;
        return docs;
      },
      (e) => {
        this.ended = true;
        throw e;
      },
    );
  }

  paginate(opts: unknown): Promise<unknown> {
    return (async () => {
      // Core's checks before the query is taken (`paginate`, an async method): the options, `numItems`.
      if (opts === undefined) throw new TypeError("Must provide arg 1 `options` to `paginate`");
      const n = (opts as { numItems?: unknown } | null)?.numItems;
      if (typeof n !== "number" || n < 0)
        throw new Error(`\`options.numItems\` must be a positive number. Received \`${n}\`.`);
      this.takeQuery();
      return this.run({ k: "paginate", opts });
    })();
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    this.startQuery();
    return this;
  }

  /**
   * The next document; a query still preparing starts here, as core's. The stream opens on the host at the first one
   * (the start's checks were made here, at `[Symbol.asyncIterator]`).
   */
  async next(): Promise<IteratorResult<unknown>> {
    if (this.state !== EXECUTING) {
      if (this.state !== PREPARING) throw closedError(this.state);
      this.startQuery();
    }
    if (this.ended) {
      this.state = CONSUMED;
      return { done: true, value: undefined };
    }
    this.stream ??= this.run({ k: "iterate" }) as Promise<number>;
    let id: number;
    try {
      id = await this.stream;
    } catch (e) {
      if (this.state === EXECUTING) {
        this.state = PREPARING;
        this.stream = null;
      }
      throw e;
    }
    const r = (await this.host.op("db.next", [id])) as IteratorResult<unknown>;
    if (r.done) {
      this.state = CONSUMED;
      this.stream = null;
    }
    return r;
  }

  /** A `for await` left early, or the app's own call: the query is consumed, and the host's stream let go. */
  async return(): Promise<IteratorResult<unknown>> {
    const stream = this.stream;
    this.stream = null;
    this.state = CONSUMED;
    if (stream) await this.host.op("db.return", [await stream]);
    return { done: true, value: undefined };
  }
}

/**
 * Core's `QueryInitializerImpl`: no state, so it can be used any number of times. Its operators and terminals are a
 * new query's on its own link (the host's initializer starts a new query for each too).
 */
export class QueryInitializerImpl extends QueryChain {
  withIndex(name: string, f?: (b: IndexRangeBuilder) => IndexRangeBuilder): QueryImpl {
    const t = this.st.t;
    return this.derive((n) => {
      // The range builder runs here, as Convex's client; the index is looked up when the query starts.
      const exprs = f ? f(new IndexRangeBuilder()).exprs : [];
      // An index the catalog has ready: its range's errors throw here, as the engine's do. Any other case (missing,
      // being built, a text index) throws when the query starts (`notFound`), as the engine's.
      n.index = { name, exprs };
      if (!t) {
        if (n.missingTable) n.notFound = () => indexUnavailable(this.table, name, "missing");
      } else {
        // Made here, as core's lookup is (its frames are this call's); thrown when the query starts.
        const found = lookupIndex(t, name, this.host.snapshot);
        if (found instanceof Error) n.notFound = () => found;
        else if (f) compileRange(found as never, exprs);
      }
      return [name, f !== undefined, exprs.map((e) => [e.op, e.field, e.value])];
    }, "withIndex");
  }

  withSearchIndex(name: string, f: (q: SearchFilterBuilder) => SearchFilterBuilder): QueryImpl {
    if (typeof f !== "function") throw new TypeError("Must provide arg 2 `filter` to `withSearchIndex`");
    const filters = (f(new SearchFilterBuilder([])) as SearchFilterBuilder).filters();
    return this.derive((n) => {
      n.search = { name, filters };
      if (!this.st.t && n.missingTable) n.notFound = () => indexUnavailable(this.table, name, "missing");
      return [name, filters.map((x) => [x.type, x.field, x.value])];
    }, "withSearchIndex");
  }

  fullTableScan(): QueryImpl {
    return this.derive(() => [], "fullTableScan");
  }

  /** A new query on this link: what the host's initializer does with the operator or the terminal. */
  private scan(): QueryImpl {
    return new QueryImpl(this.host, this.table, this.st);
  }

  order(dir: "asc" | "desc"): QueryImpl {
    return this.scan().order(dir);
  }
  filter(predicate: (q: FilterBuilder) => unknown): QueryImpl {
    return this.scan().filter(predicate);
  }
  limit(n: number): QueryImpl {
    return this.scan().limit(n);
  }
  take(n: number): Promise<unknown> {
    return this.scan().take(n);
  }
  first(): Promise<unknown> {
    return this.scan().first();
  }
  unique(): Promise<unknown> {
    return this.scan().unique();
  }
  collect(): Promise<unknown> {
    return this.scan().collect();
  }
  paginate(opts: unknown): Promise<unknown> {
    return this.scan().paginate(opts);
  }
  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this.scan()[Symbol.asyncIterator]();
  }

  async count(): Promise<unknown> {
    return this.host.op("db.query", [this.st.query, { k: "count" }]);
  }
}

/** What a virtual table's queries share (core `VirtualChain`). */
export abstract class VirtualChain<Q extends QueryImpl | QueryInitializerImpl = QueryImpl | QueryInitializerImpl> {
  constructor(
    protected readonly table: string,
    protected readonly q: Q,
  ) {}
  protected wrap(q: QueryImpl): VirtualQuery {
    return new VirtualQuery(this.table, q);
  }
  order(dir: "asc" | "desc") {
    return this.wrap(this.q.order(dir));
  }
  filter(predicate: (q: FilterBuilder) => unknown) {
    return this.wrap(this.q.filter(predicate));
  }
  limit(n: number) {
    return this.wrap(this.q.limit(n));
  }
  take(n: number) {
    return this.q.take(n);
  }
  first() {
    return this.q.first();
  }
  unique() {
    return this.q.unique();
  }
  collect() {
    return this.q.collect();
  }
  paginate(opts: unknown) {
    return this.q.paginate(opts);
  }
}

/** A virtual table's query after its first operator (core `VirtualQuery`): its own iterator. */
export class VirtualQuery extends VirtualChain<QueryImpl> {
  [Symbol.asyncIterator]() {
    this.q[Symbol.asyncIterator]();
    return this;
  }
  next() {
    return this.q.next();
  }
  return() {
    return this.q.return();
  }
}

/** `db.system.query(table)` (core `VirtualQueryInitializer`). */
export class VirtualQueryInitializer extends VirtualChain<QueryInitializerImpl> {
  constructor(
    table: string,
    q: QueryInitializerImpl,
    private readonly anyIndex = false,
  ) {
    super(table, q);
  }
  count() {
    return this.q.count();
  }
  withIndex(name: string, range?: (b: IndexRangeBuilder) => IndexRangeBuilder) {
    if (!this.anyIndex && !VIRTUAL_INDEXES.has(name)) throw new Error(`unknown index ${this.table}.${name}`);
    return this.wrap(this.q.withIndex(name, range));
  }
  withSearchIndex(name: string): VirtualQuery {
    throw new Error(`Index ${this.table}.${name} not found.`);
  }
  fullTableScan() {
    return this.wrap(this.q.fullTableScan());
  }
  [Symbol.asyncIterator]() {
    return this.fullTableScan()[Symbol.asyncIterator]();
  }
}

const newChain = (query: number, t: WireTable | undefined, missingTable = false): ChainState => ({
  query,
  t,
  missingTable,
  orderSet: false,
  desc: false,
  ops: [],
});

/** `db.system` (core `SystemReader`): its reads the host's; `normalizeId` from the catalog. */
export class SystemReader {
  constructor(private readonly db: Tx) {}

  async get(tableOrId: string, id?: string): Promise<unknown> {
    return this.db.host.op("db.system.get", id === undefined ? [tableOrId] : [tableOrId, id]);
  }

  normalizeId(table: string, id: string): string | null {
    const vt = VIRTUAL_TABLES.get(table);
    if (!vt && typeof table === "string" && !table.startsWith("_"))
      throw new Error("User tables can only be accessed from db.normalizeId().");
    if (!vt) return null;
    return this.db.normalizeIdAs(vt.system, id, true);
  }

  table(name: string): TableReader {
    return new TableReader(this as never, name);
  }

  query(table: string): VirtualQueryInitializer {
    if (!VIRTUAL_TABLES.has(table) && table.startsWith("_")) {
      // Another system table: any index name, its reads find nothing (the host's).
      return new VirtualQueryInitializer(
        table,
        new QueryInitializerImpl(
          this.db.host,
          table,
          newChain(this.db.host.link("open", null, [table, true]), undefined),
        ),
        true,
      );
    }
    const vt = VIRTUAL_TABLES.get(table);
    if (!vt)
      throw new Error(
        table.startsWith("_")
          ? `System table ${table} is not accessible here.`
          : "User tables can only be accessed from db.query().",
      );
    return new VirtualQueryInitializer(
      table,
      new QueryInitializerImpl(
        this.db.host,
        table,
        newChain(this.db.host.link("open", null, [table, true]), this.db.host.table(vt.system)),
      ),
    );
  }
}

/**
 * `ctx.db`: core `Tx`'s surface an app reaches (`get`, `query`, `normalizeId`, the writes, `vars`, `system`,
 * `table`); a `reader` (a query run inside a mutation) has no writes and no `vars`, as `readerView`'s.
 */
export class Tx {
  constructor(
    readonly host: DbHost,
    private readonly shape: DbShape,
  ) {}

  get vars(): { commitTs: typeof commitTsPlaceholder } | undefined {
    return this.shape === "writer" ? { commitTs: commitTsPlaceholder } : undefined;
  }

  get system(): SystemReader {
    return new SystemReader(this);
  }

  table(name: string): TableReader | TableWriter {
    return this.shape === "writer" ? new TableWriter(this as never, name) : new TableReader(this as never, name);
  }

  get(tableOrId: string, id?: string): Promise<unknown> {
    return this.host.op("db.get", id === undefined ? [tableOrId] : [tableOrId, id]);
  }

  query(table: string): QueryInitializerImpl {
    this.findTable(table);
    const t = this.host.table(table);
    return new QueryInitializerImpl(this.host, table, newChain(this.host.link("open", null, [table, false]), t, !t));
  }

  /** Core `Tx.findTable`'s synchronous guard, as `query` calls it (its read of the table is the host's link's). */
  private findTable(name: string) {
    if (name.startsWith("_")) throw new Error(SYSTEM_TABLE_QUERY);
  }

  normalizeId(table: string, idString: string): string | null {
    if (typeof table !== "string") throw new Error("Invalid argument `table` for `db.normalizeId`");
    if (table.startsWith("_")) throw new Error("System tables can only be accessed from db.system.normalizeId().");
    return this.normalizeIdAs(table, idString, false);
  }

  /** Core `Tx.normalizeId` past its guards: `idString` as an id of `table`, or null. */
  normalizeIdAs(table: string, idString: string, system: boolean): string | null {
    const t = this.host.table(table);
    if (!t || (t.name.startsWith("_") && !system) || typeof idString !== "string") return null;
    try {
      return decodeId(idString).tableNumber === t.number ? idString : null;
    } catch {
      return null;
    }
  }

  insert(table: string, value: unknown): Promise<unknown> {
    return this.host.op("db.insert", [table, value]);
  }
  patch(...args: unknown[]): Promise<unknown> {
    return this.host.op("db.patch", args);
  }
  replace(...args: unknown[]): Promise<unknown> {
    return this.host.op("db.replace", args);
  }
  delete(...args: unknown[]): Promise<unknown> {
    return this.host.op("db.delete", args);
  }
}

/** A reader's view (core `readerView`): no writes, no `vars`, `table()` a reader. */
export function readerOf(db: Tx): Tx {
  const hidden = new Set(["insert", "patch", "replace", "delete", "vars"]);
  return new Proxy(db, {
    get(target, prop) {
      if (typeof prop === "string" && hidden.has(prop)) return undefined;
      if (prop === "table") return (name: string) => new TableReader(target as never, name);
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
