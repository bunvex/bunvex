// A transaction: reads at a snapshot, records its read-set, buffers its writes, and turns them into
// persistence rows (document versions + the index entries that changed).
//
// Read-your-own-writes (as Convex's TransactionIndex does): every write also updates, per index, an
// ordered map of PENDING entries — `key → doc` for the version this transaction wrote, `key → null` for
// an entry it removed (a delete, or a patch that moved the indexed value). A range read merges the
// snapshot with the pending entries of that range, in key order; on an equal key the pending entry wins.

import {
  checkValue,
  copyValue,
  decodeId,
  encodeId,
  fromJsonValue,
  type GenericValidator,
  isSimpleObject,
  toJsonValue,
  type Value,
  v,
  valueNesting,
  valueSize,
} from "@bunvex/values";
import BTree from "sorted-btree";
import { Catalog, INDEX_TABLE, type IndexMeta, planCatalog, TABLES_TABLE, type TableMeta } from "./catalog.ts";
import type { Interval } from "./committer.ts";
import { type CursorPosition, decodeCursor, encodeCursor, queryFingerprint } from "./cursor.ts";
import { nextUp, outsideExecution, wallClock } from "./determinism.ts";
import { type ExpressionOrValue, type FilterBuilder, filterBuilder, passes } from "./filter.ts";
import { compareKeys, encodeKey, type KeyValue, prefixEnd } from "./keyenc.ts";
import type { DocWrite, IndexWrite, Persistence, ScanDocs } from "./persistence/index.ts";
import { checkIdentifier, type Doc, type IndexDef, indexKey, type TableDef } from "./schema.ts";

const ANY = v.any();

type Range = { lo: Uint8Array; hi: Uint8Array };
const FULL: Range = { lo: new Uint8Array(0), hi: Uint8Array.from([0xff, 0xff, 0xff, 0xff]) };

type RangeExpr = { op: "eq" | "gt" | "gte" | "lt" | "lte"; field: string; value: KeyValue };

/** `withIndex(name, q => q.eq(…).gt(…))`: records the expressions; `compile` checks them against the index. */
export class IndexRangeBuilder {
  readonly exprs: RangeExpr[] = [];
  eq(field: string, value: KeyValue) {
    this.exprs.push({ op: "eq", field, value });
    return this;
  }
  gt(field: string, value: KeyValue) {
    this.exprs.push({ op: "gt", field, value });
    return this;
  }
  gte(field: string, value: KeyValue) {
    this.exprs.push({ op: "gte", field, value });
    return this;
  }
  lt(field: string, value: KeyValue) {
    this.exprs.push({ op: "lt", field, value });
    return this;
  }
  lte(field: string, value: KeyValue) {
    this.exprs.push({ op: "lte", field, value });
    return this;
  }
}

const COMPARATOR = { eq: "==", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;
const quoted = (f: string) => JSON.stringify(f);
const list = (fs: string[]) => `[${fs.map(quoted).join(", ")}]`;

/**
 * Turn range expressions into a key interval, with Convex's rules and errors (`IndexRange::compile` in
 * crates/common/src/query.rs): equalities on distinct fields, at most one lower and one upper bound, both
 * on the same field, and together a prefix of the index's fields in order (the trailing `_id` included).
 */
export function compileRange(ix: IndexDef, exprs: RangeExpr[]): Range {
  const indexName = `${ix.table}.${ix.name}`;
  const indexed = ix.name === "by_id" ? [] : ix.fields; // the fields Convex lists; `_id` is implicit
  const withId = [...indexed, "_id"];
  const eqs = new Map<string, KeyValue>();
  let ineqField: string | null = null;
  let lower: { v: KeyValue; incl: boolean } | null = null;
  let upper: { v: KeyValue; incl: boolean } | null = null;
  for (const e of exprs) {
    if (e.op === "eq") {
      if (eqs.has(e.field))
        throw new Error(
          `Already defined equality bound in index range. Can't add ${quoted(e.field)} == ${JSON.stringify(e.value)}.`,
        );
      eqs.set(e.field, e.value);
      continue;
    }
    const isUpper = e.op === "lt" || e.op === "lte";
    if ((isUpper ? upper : lower) !== null)
      throw new Error(
        `Already defined ${isUpper ? "upper" : "lower"} bound in index range. Can't add ${quoted(e.field)} ${COMPARATOR[e.op]} ${JSON.stringify(e.value)}.`,
      );
    if (ineqField !== null && ineqField !== e.field)
      throw new Error(
        `Upper and lower bounds in \`range\` can only be applied to a single index field. This query against index ${indexName} attempted to set a range bound on both ${quoted(ineqField)} and ${quoted(e.field)}. Consider using \`filter\` instead.`,
      );
    ineqField = e.field;
    const bound = { v: e.value, incl: e.op === "lte" || e.op === "gte" };
    if (isUpper) upper = bound;
    else lower = bound;
  }
  const rank = new Map(withId.map((f, i) => [f, i]));
  for (const f of [...eqs.keys(), ...(ineqField ? [ineqField] : [])])
    if (!rank.has(f))
      throw new Error(
        `The index range included a comparison with ${quoted(f)}, but ${indexName} with fields ${list(indexed)} doesn't index this field.`,
      );
  const eqFields = [...eqs.keys()].sort((a, b) => rank.get(a)! - rank.get(b)!);
  const used = [...eqFields, ...(ineqField ? [ineqField] : [])];
  used.forEach((f, i) => {
    if (withId[i] !== f)
      throw new Error(
        `Tried to query index ${indexName} but the query didn't use the index fields in order.\nIndex fields: ${list(indexed)}\nQuery fields: ${list(used)}\nFirst incorrect field: ${quoted(f)}`,
      );
  });
  const keyValue = (_f: string, v: KeyValue): KeyValue => v;
  const prefixVals = eqFields.map((f) => keyValue(f, eqs.get(f)!));
  if (prefixVals.length === 0 && !lower && !upper) return FULL;
  const prefix = encodeKey(prefixVals);
  let lo = prefixVals.length ? prefix : FULL.lo;
  let hi = prefixVals.length ? prefixEnd(prefix) : FULL.hi;
  if (lower) {
    const k = encodeKey([...prefixVals, keyValue(ineqField!, lower.v)]);
    lo = lower.incl ? k : prefixEnd(k);
  }
  if (upper) {
    const k = encodeKey([...prefixVals, keyValue(ineqField!, upper.v)]);
    hi = upper.incl ? prefixEnd(k) : k;
  }
  return { lo, hi };
}

/** Convex's document and write limits (crates/common/src/document.rs, knobs.rs). */
export const MAX_USER_SIZE = 1 << 20; // 1 MiB, the size of the whole document (system fields included)
export const MAX_DOCUMENT_NESTING = 16;
export const TRANSACTION_MAX_NUM_USER_WRITES = 16_000;
export const TRANSACTION_MAX_USER_WRITE_SIZE_BYTES = 1 << 24; // 16 MiB

/** A byte count as binary units, as the limit messages print it: "16 MiB", "1.05 MiB", "512 B". */
function formatBytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${i === 0 ? x : Number(x.toFixed(2))} ${units[i]}`;
}

/** Convex's per-transaction read limits (crates/common/src/knobs.rs). System transactions are exempt. */
export const TRANSACTION_MAX_READ_SIZE_ROWS = 32_000;
export const TRANSACTION_MAX_READ_SIZE_BYTES = 1 << 24; // 16 MiB
export const TRANSACTION_MAX_READ_SET_INTERVALS = 4096;
const OVER_LIMIT_HELP =
  "Consider using smaller limits in your queries, paginating your queries, or using indexed queries with a selective index range expressions.";

type QState = {
  t: TableDef | undefined;
  ix: IndexDef | undefined;
  range: Range;
  desc: boolean;
  orderSet: boolean;
  filters: ExpressionOrValue[];
  stage: "initializer" | "query";
  closed: boolean;
  iterated: boolean;
};

/** A query under construction (Convex's QueryInitializer / Query / OrderedQuery in one shape). */
export type TxQuery = {
  withIndex(name: string, range?: (b: IndexRangeBuilder) => IndexRangeBuilder): TxQuery;
  fullTableScan(): TxQuery;
  order(dir: "asc" | "desc"): TxQuery;
  filter(predicate: (q: FilterBuilder) => ExpressionOrValue<boolean>): TxQuery;
  take(n: number): Promise<Doc[]>;
  first(): Promise<Doc | null>;
  unique(): Promise<Doc | null>;
  collect(): Promise<Doc[]>;
  paginate(opts: PaginationOptions): Promise<PaginationResult>;
  [Symbol.asyncIterator](): AsyncIterator<Doc>;
};

/** Convex's `PaginationOptions`. */
export type PaginationOptions = {
  numItems: number;
  cursor: string | null;
  endCursor?: string | null;
  id?: number;
  maximumRowsRead?: number;
  maximumBytesRead?: number;
};
/** Convex's `PaginationResult`. */
export type PaginationResult = {
  page: Doc[];
  isDone: boolean;
  continueCursor: string;
  splitCursor: string | null;
  pageStatus: "SplitRecommended" | "SplitRequired" | null;
};

export class Tx {
  reads: Interval[] = [];
  /** The instance secret that signs pagination cursors (STUDY-17). */
  instanceSecret = "";
  /**
   * Reactive pagination's journal: the end cursor of this query's previous run (a subscription re-run
   * keeps its page boundary), and the one this run ends at.
   */
  prevEndCursor: string | null = null;
  nextEndCursor: string | null = null;
  private paginated = false;
  /** Documents and bytes read from the snapshot, counted against Convex's limits. */
  private docsRead = 0;
  private bytesRead = 0;
  private writes = new Map<string, { table: TableDef; old: Doc | null; next: Doc | null }>();
  /** Per index id: this transaction's pending entries, `key → doc` (written) or `null` (removed). */
  private pending = new Map<number, BTree<Uint8Array, Doc | null>>();
  constructor(
    private catalog: Catalog,
    private persistence: Persistence,
    readonly snapshot: number,
    private readonly writable: boolean,
    /** The next `_creationTime` to hand out: the transaction's start time, then strictly increasing. */
    private nextCreationTime: number = wallClock(),
    /** System transactions (the engine's own) may touch `_`-prefixed system tables; app code may not. */
    private readonly system = false,
  ) {
    this.day = Math.floor(nextCreationTime / 86_400_000);
  }
  /** Days since the Unix epoch at the transaction's start: the last two bytes of every id it creates. */
  private readonly day: number;

  private tableDef(name: string) {
    const t = this.findTable(name);
    if (!t) throw new Error(`unknown table ${name}`);
    return t;
  }

  /** A table visible to this transaction (the catalog, or one it created), or undefined. */
  private findTable(name: string): TableDef | undefined {
    if (name.startsWith("_") && !this.systemAccess) throw new Error(`System table ${name} is not accessible here.`);
    return this.catalog.tables.get(name) ?? this.createdTables.get(name)?.def;
  }

  /** Tables this transaction created (STUDY-14: a write to an unknown table creates it, as in Convex). */
  readonly createdTables = new Map<
    string,
    { def: TableDef; meta: Omit<TableMeta, "_id">; indexes: Omit<IndexMeta, "_id">[] }
  >();
  private systemDepth = 0;

  /** Who runs this transaction: the server's identity object (opaque here), or null without a token. */
  identity: unknown = null;
  /** Whether the body read the identity (Convex's `observe_identity`): its result then depends on the caller. */
  identityObserved = false;
  /** The caller's identity, recording that the result depends on it (`ctx.auth.getUserIdentity()`). */
  readIdentity(): unknown {
    this.identityObserved = true;
    return this.identity;
  }
  private get systemAccess() {
    return this.system || this.systemDepth > 0;
  }

  /**
   * Run `fn` with access to system tables, inside an app transaction: for the engine's own records that
   * must commit with the app's writes (the sync protocol's `_session_requests`). Not for app code.
   */
  async asSystem<T>(fn: () => Promise<T>): Promise<T> {
    this.systemDepth++;
    try {
      return await fn();
    } finally {
      this.systemDepth--;
    }
  }

  /**
   * A read of a table that does not exist yet: nothing, but the read depends on `_tables`, so a cached
   * query or a subscription re-runs when the table is created.
   */
  private readMissingTable() {
    const byCreation = this.catalog.table(TABLES_TABLE).indexes.get("by_creation_time")!;
    this.recordInterval({ index: byCreation.id, lo: FULL.lo, hi: FULL.hi });
  }

  /** Create table `name` in this transaction: the next free Convex number, a fresh tablet, system indexes. */
  private async createTable(name: string): Promise<TableDef> {
    checkIdentifier("table", name);
    if (name.startsWith("_")) throw new Error(`Invalid table name "${name}": names starting with "_" are reserved.`);
    this.systemDepth++;
    try {
      const tables = (await this.query(TABLES_TABLE).collect()) as unknown as TableMeta[];
      const indexes = (await this.query(INDEX_TABLE).collect()) as unknown as IndexMeta[];
      const plan = planCatalog([{ name, indexes: {}, document: ANY }], tables, indexes);
      const meta = plan.insertTables[0];
      for (const t of plan.insertTables) await this.insert(TABLES_TABLE, t);
      for (const i of plan.insertIndexes) await this.insert(INDEX_TABLE, i);
      const def = new Catalog().add(
        name,
        meta.tablet,
        meta.number,
        plan.insertIndexes.map((i) => ({ name: i.name, fields: i.fields, id: i.indexId })),
      );
      this.createdTables.set(name, { def, meta, indexes: plan.insertIndexes });
      return def;
    } finally {
      this.systemDepth--;
    }
  }

  private recordInterval(i: Interval) {
    this.reads.push(i);
    if (!this.system && this.reads.length > TRANSACTION_MAX_READ_SET_INTERVALS)
      throw new Error(
        `Too many reads in a single function execution (limit: ${TRANSACTION_MAX_READ_SET_INTERVALS}). ${OVER_LIMIT_HELP}`,
      );
  }

  /** Count one document read (its JSON), as Convex's `record_read_document`: the count grows even when it throws. */
  private recordDoc(json: string) {
    this.docsRead++;
    this.bytesRead += json.length;
    if (this.system) return;
    if (this.docsRead > TRANSACTION_MAX_READ_SIZE_ROWS)
      throw new Error(
        `Too many documents read in a single function execution (limit: ${TRANSACTION_MAX_READ_SIZE_ROWS}). ${OVER_LIMIT_HELP}`,
      );
    if (this.bytesRead > TRANSACTION_MAX_READ_SIZE_BYTES)
      throw new Error(
        `Too many bytes read in a single function execution (limit: ${TRANSACTION_MAX_READ_SIZE_BYTES} bytes). ${OVER_LIMIT_HELP}`,
      );
  }

  /**
   * Check an id argument as Convex does: it must decode, and if it names a known table that table must be
   * `table`. Returns false when it names no known table (Convex's `db.get` then returns null).
   */
  private checkId(table: string, id: string, method: string): boolean {
    let n: number;
    try {
      n = decodeId(id).tableNumber;
    } catch (e) {
      throw new Error(`Invalid argument \`id\` for \`${method}\`: ${(e as Error).message}`);
    }
    const actual = this.catalog.byNumber(n);
    if (!actual) return false;
    if (actual.name !== table)
      throw new Error(
        `Invalid argument \`id\` for \`${method}\`: expected to be an Id<"${table}">, got Id<"${actual.name}"> instead.`,
      );
    return true;
  }

  /** `db.get(table, id)`, or Convex's one-argument `db.get(id)`: the id names its table. */
  async get(tableOrId: string, id?: string): Promise<Doc | null> {
    if (id !== undefined) return this.read(tableOrId, id, "db.get");
    const table = this.tableOfIdArg(tableOrId, "db.get");
    return table === undefined ? null : this.read(table, tableOrId, "db.get");
  }

  /** The table an id argument names (one-argument forms); undefined when it names no known table. */
  private tableOfIdArg(id: unknown, method: string): string | undefined {
    if (typeof id !== "string")
      throw new Error(`Invalid argument \`id\` for \`${method}\`, expected string but got '${typeof id}': ${id}`);
    let n: number;
    try {
      n = decodeId(id).tableNumber;
    } catch (e) {
      throw new Error(`Invalid argument \`id\` for \`${method}\`: ${(e as Error).message}`);
    }
    const name = this.catalog.byNumber(n)?.name;
    if (name?.startsWith("_") && !this.systemAccess) return undefined;
    return name;
  }

  /** Convex's `db.normalizeId(table, s)`: `s` as an id of `table`, or null. */
  normalizeId(table: string, idString: string): string | null {
    if (typeof table !== "string") throw new Error("Invalid argument `table` for `db.normalizeId`");
    if (table.startsWith("_") && !this.systemAccess) return null;
    const t = this.catalog.tables.get(table) ?? this.createdTables.get(table)?.def;
    if (!t || typeof idString !== "string") return null;
    try {
      return decodeId(idString).tableNumber === t.number ? idString : null;
    } catch {
      return null;
    }
  }

  private async read(table: string, id: string, method: string): Promise<Doc | null> {
    const t = this.findTable(table);
    if (!t) {
      this.readMissingTable();
      return null;
    }
    if (!this.checkId(table, id, method)) return null;
    const w = this.writes.get(id);
    // A copy: mutating what `get` returned must not change what this transaction wrote.
    if (w) return w.next && structuredClone(w.next);
    const k = encodeKey([id]);
    this.recordInterval({ index: t.byId.id, lo: k, hi: prefixEnd(k) });
    const json = await outsideExecution(() => this.persistence.get(t.id, id, this.snapshot));
    if (json) this.recordDoc(json);
    return json ? decodeDoc(json) : null;
  }

  /**
   * `db.query(table)`: an immutable chain as Convex's (`QueryInitializer` → `Query`): each operator returns
   * a new query and closes the previous one; `withIndex` / `fullTableScan` only on the initializer; `order`
   * at most once; results by `collect` / `take` / `first` / `unique` / `for await` (STUDY-16).
   */
  query(table: string): TxQuery {
    const t = this.findTable(table);
    if (!t) this.readMissingTable(); // a missing table has no rows; the read depends on _tables
    const st: QState = {
      t,
      ix: t?.indexes.get("by_creation_time"),
      range: FULL,
      desc: false,
      orderSet: false,
      filters: [],
      stage: "initializer",
      closed: false,
      iterated: false,
    };
    return this.makeQuery(table, st);
  }

  private makeQuery(table: string, st: QState): TxQuery {
    return new QueryImpl(this, table, st);
  }

  /** @internal (QueryImpl) */
  async *iterate(st: QState): AsyncGenerator<Doc> {
    if (!st.t || !st.ix) return;
    this.recordInterval({ index: st.ix.id, lo: st.range.lo, hi: st.range.hi });
    for await (const d of this.stream(st)) if (st.filters.every((f) => passes(f, d))) yield d;
  }

  private async snapshotRange(st: QState, lo: Uint8Array, hi: Uint8Array, limit: number): Promise<Doc[]> {
    const t = st.t!;
    const ix = st.ix!;
    const p = this.persistence as Persistence & Partial<ScanDocs>;
    if (p.scanDocs) {
      // Remote persistence fuses the index range and the document fetches into one round trip.
      const rows = await outsideExecution(() => p.scanDocs!(t.id, ix.id, lo, hi, this.snapshot, limit, st.desc));
      for (const j of rows) this.recordDoc(j);
      return rows.map(decodeDoc);
    }
    const ids = await outsideExecution(() => this.persistence.scan(ix.id, lo, hi, this.snapshot, limit, st.desc));
    const out: Doc[] = [];
    for (const id of ids) {
      const json = await outsideExecution(() => this.persistence.get(t.id, id, this.snapshot));
      if (json) {
        this.recordDoc(json);
        out.push(decodeDoc(json));
      }
    }
    return out;
  }

  /** Up to `limit` documents of [lo, hi), this transaction's own writes merged in. */
  private async page(st: QState, lo: Uint8Array, hi: Uint8Array, limit: number): Promise<Doc[]> {
    const ix = st.ix!;
    const pend: [Uint8Array, Doc | null][] = [];
    this.pending.get(ix.id)?.forRange(lo, hi, false, (k, val) => {
      pend.push([k, val]);
    });
    if (pend.length === 0) return this.snapshotRange(st, lo, hi, limit); // the common case: nothing written here
    return this.mergePending(
      ix,
      pend,
      await this.snapshotRange(st, lo, hi, limit + countRemovals(pend)),
      limit,
      st.desc,
    );
  }

  /** Every document of the range in order, fetched in growing pages past the last key seen. */
  private async *stream(st: QState): AsyncGenerator<Doc> {
    let lo = st.range.lo;
    let hi = st.range.hi;
    let n = 64;
    for (;;) {
      const docs = await this.page(st, lo, hi, n);
      for (const d of docs) yield d;
      if (docs.length < n) return;
      const last = indexKey(st.ix!, docs[docs.length - 1]);
      if (st.desc) hi = last;
      else {
        lo = new Uint8Array(last.length + 1);
        lo.set(last);
      }
      n = Math.min(n * 2, 1024);
    }
  }

  /** `.paginate()` as Convex's `query_page` (crates/isolate/src/environment/udf/async_syscall.rs). */
  /** @internal (QueryImpl) */
  async paginate(table: string, st: QState, opts: PaginationOptions): Promise<PaginationResult> {
    const n = opts?.numItems;
    if (typeof n !== "number" || !(n > 0))
      throw new Error(`\`options.numItems\` must be a positive number. Received \`${n}\`.`);
    const pageSize = Math.floor(n);
    if (pageSize === 0) throw new Error("Must request at least 1 document while paginating");
    if (pageSize > TRANSACTION_MAX_READ_SIZE_ROWS) throw new Error(`Requested too many items: ${pageSize}`);
    if (opts.maximumRowsRead === 0 || opts.maximumBytesRead === 0)
      throw new Error("maximumRowsRead and maximumBytesRead must be greater than 0");
    if (this.paginated)
      throw new Error(
        "This query or mutation function ran multiple paginated queries. Only a single paginated query is supported in each function.",
      );
    this.paginated = true;
    const fp = queryFingerprint({
      tablet: st.t?.id ?? 0,
      index: st.ix?.id ?? 0,
      lo: st.range.lo,
      hi: st.range.hi,
      desc: st.desc,
    });
    const secret = this.instanceSecret;
    const start = opts.cursor ? decodeCursor(secret, opts.cursor, fp) : null;
    const endStr = opts.endCursor ?? this.prevEndCursor;
    const end = endStr ? decodeCursor(secret, endStr, fp) : null;
    const done = (page: Doc[], pos: CursorPosition, status: PaginationResult["pageStatus"], split: string | null) => {
      const continueCursor = encodeCursor(secret, pos, fp);
      this.nextEndCursor = continueCursor;
      return { page, isDone: pos === "end", continueCursor, splitCursor: split, pageStatus: status };
    };
    if (!st.t || !st.ix) return done([], "end", null, null);
    if (start === "end") {
      this.recordInterval({ index: st.ix.id, lo: st.range.lo, hi: st.range.lo });
      return done([], "end", null, null);
    }
    // The page's range: after the start cursor, up to (and including) the end cursor.
    const succ = (k: Uint8Array) => {
      const x = new Uint8Array(k.length + 1);
      x.set(k);
      return x;
    };
    let lo = st.range.lo;
    let hi = st.range.hi;
    if (!st.desc) {
      if (start) lo = succ(start.after);
      if (end && end !== "end") hi = succ(end.after);
    } else {
      if (start) hi = start.after;
      if (end && end !== "end") lo = end.after;
    }
    const page: Doc[] = [];
    const keys: Uint8Array[] = [];
    let rowsRead = 0;
    let bytesRead = 0;
    let last: Uint8Array | null = null;
    let exhausted = true;
    let status: PaginationResult["pageStatus"] = null;
    const maxRows = opts.maximumRowsRead;
    const maxBytes = opts.maximumBytesRead;
    const sub: QState = { ...st, range: { lo, hi } };
    for await (const d of this.stream(sub)) {
      if ((maxRows !== undefined && rowsRead >= maxRows) || (maxBytes !== undefined && bytesRead >= maxBytes)) {
        status = "SplitRequired";
        exhausted = false;
        break;
      }
      rowsRead++;
      bytesRead += valueSize(d as unknown as Value);
      last = indexKey(st.ix, d);
      if (st.filters.every((f) => passes(f, d))) {
        page.push(d);
        keys.push(last);
        // As Convex: a full page stops without looking further, so its cursor is "after the last
        // document" even if nothing follows (the next page is then empty and done).
        if (!end && page.length >= pageSize) {
          exhausted = false;
          break;
        }
      }
    }
    // Read-set: the range this page covers (to the end cursor, or to the last key read).
    const readHi = st.desc ? hi : exhausted ? hi : succ(last ?? lo);
    const readLo = st.desc ? (exhausted ? lo : (last ?? hi)) : lo;
    this.recordInterval({ index: st.ix.id, lo: readLo, hi: readHi });
    if (
      status === null &&
      ((maxRows !== undefined && rowsRead > (maxRows * 3) / 4) ||
        (maxBytes !== undefined && bytesRead > (maxBytes * 3) / 4) ||
        page.length > (8192 * 3) / 4)
    )
      status = "SplitRecommended";
    const split =
      status && keys.length > 2 ? encodeCursor(secret, { after: keys[Math.floor(keys.length / 2)] }, fp) : null;
    // A page with a pinned end reports that end as its continue cursor even when it stopped early at a read
    // limit (Convex's `end_cursor.or_else(query.cursor())`): the halves of its split then still cover it all.
    const pos: CursorPosition = end ?? (exhausted ? "end" : { after: last ?? lo });
    return done(page, pos, status, split);
  }

  /** @internal (QueryImpl) The row limit of a `collect()`: one past the read limit raises its error. */
  collectLimit() {
    return this.system ? 1_000_000 : TRANSACTION_MAX_READ_SIZE_ROWS - this.docsRead + 1;
  }

  /** @internal (QueryImpl) */
  async runQuery(st: QState, limit: number): Promise<Doc[]> {
    if (limit <= 0 || !st.t || !st.ix) return [];
    // Read-set = the whole scanned interval (a take(n) could narrow it to what was read; that only affects
    // how often the query cache is invalidated, never correctness).
    this.recordInterval({ index: st.ix.id, lo: st.range.lo, hi: st.range.hi });
    if (st.filters.length === 0) return this.page(st, st.range.lo, st.range.hi, limit);
    // With filters: stream until `limit` documents pass (reads count toward the limits as they happen).
    const out: Doc[] = [];
    for await (const d of this.stream(st)) {
      if (st.filters.every((f) => passes(f, d))) out.push(d);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Merge a snapshot range with this transaction's pending entries for the same range. The snapshot was
   * fetched with `limit + removals` rows: each pending removal hides at most one of them, so the first
   * `limit` merged rows are exact — any pending entry past the fetched horizon sorts after at least
   * `limit` surviving snapshot rows.
   */
  private mergePending(
    ix: IndexDef,
    pend: [Uint8Array, Doc | null][],
    snapshot: Doc[],
    limit: number,
    desc: boolean,
  ): Doc[] {
    const shadowed = new Set(pend.map(([k]) => Buffer.from(k).toString("hex")));
    const rows: [Uint8Array, Doc][] = [];
    for (const d of snapshot) {
      const k = indexKey(ix, d);
      if (!shadowed.has(Buffer.from(k).toString("hex"))) rows.push([k, d]);
    }
    for (const [k, d] of pend) if (d) rows.push([k, d]);
    rows.sort((a, b) => (desc ? compareKeys(b[0], a[0]) : compareKeys(a[0], b[0])));
    return rows.slice(0, limit).map(([, d]) => d);
  }

  private docsWritten = 0;
  private bytesWritten = 0;

  /** Convex's per-document and per-transaction write limits (crates/common/src/document.rs, knobs.rs). */
  private checkWriteLimits(next: Doc | null) {
    if (next) {
      const v = next as unknown as Value;
      const nesting = valueNesting(v);
      if (nesting > MAX_DOCUMENT_NESTING)
        throw new Error(
          `Document is too nested (nested ${nesting} levels deep > maximum nesting ${MAX_DOCUMENT_NESTING})`,
        );
      const size = valueSize(v);
      if (size > MAX_USER_SIZE)
        throw new Error(`Value is too large (${formatBytes(size)} > maximum size ${formatBytes(MAX_USER_SIZE)})`);
      this.bytesWritten += size;
    }
    this.docsWritten++;
    if (this.docsWritten > TRANSACTION_MAX_NUM_USER_WRITES)
      throw new Error(`Too many writes in a single function execution (limit: ${TRANSACTION_MAX_NUM_USER_WRITES})`);
    if (this.bytesWritten > TRANSACTION_MAX_USER_WRITE_SIZE_BYTES)
      throw new Error(
        `Too many bytes written in a single function execution (limit: ${formatBytes(TRANSACTION_MAX_USER_WRITE_SIZE_BYTES)})`,
      );
  }

  /** Validators of the declared tables' documents; set by the engine for mutations (STUDY-14). */
  docValidators: Map<string, GenericValidator> | null = null;

  private stage(t: TableDef, id: string, old: Doc | null, next: Doc | null) {
    if (!this.writable) throw new Error("queries cannot write");
    if (!t.name.startsWith("_")) this.checkWriteLimits(next);
    const dv = next && this.docValidators?.get(t.name);
    if (dv) {
      const msg = checkValue(dv, next as unknown as Value, (n) => this.catalog.byNumber(n)?.name);
      if (msg)
        throw new Error(
          `Failed to insert or update a document in table "${t.name}" because it does not match the schema: ${msg}`,
        );
    }
    const prev = this.writes.get(id);
    // The version this transaction currently sees (its own last write, or the snapshot's).
    const current = prev ? prev.next : old;
    for (const ix of t.indexes.values()) {
      const curKey = current ? indexKey(ix, current) : null;
      const newKey = next ? indexKey(ix, next) : null;
      let tree = this.pending.get(ix.id);
      if (!tree) {
        tree = new BTree<Uint8Array, Doc | null>(undefined, compareKeys);
        this.pending.set(ix.id, tree);
      }
      if (curKey && (!newKey || compareKeys(curKey, newKey) !== 0)) tree.set(curKey, null);
      if (newKey && next) tree.set(newKey, next);
    }
    this.writes.set(id, { table: t, old: prev ? prev.old : old, next });
  }

  async insert(table: string, fields: Record<string, unknown>): Promise<string> {
    if (!this.writable) throw new Error("queries cannot write");
    const t = this.findTable(table) ?? (await this.createTable(table));
    // Convex's generator (STUDY-01): 14 random bytes, then the transaction's day number (big-endian). The
    // randomness is the real CSPRNG, drawn outside the deterministic execution.
    const internal = new Uint8Array(16);
    outsideExecution(() => crypto.getRandomValues(internal.subarray(0, 14)));
    internal[14] = this.day >> 8;
    internal[15] = this.day & 0xff;
    const id = encodeId(t.number, internal);
    // As in Convex: each insert takes the next float, so a transaction's inserts sort in insert order.
    const creationTime = this.nextCreationTime;
    this.nextCreationTime = nextUp(creationTime);
    // Validated and copied at the call, as Convex serializes the value: an unsupported type throws here, and
    // mutating `fields` afterwards cannot change what is written.
    const doc = { ...copyFields(fields, "insert"), _id: id, _creationTime: creationTime };
    checkSystemFields(doc, fields, id, creationTime);
    this.stage(t, id, null, sortFields(doc));
    return id;
  }

  /** `db.patch(table, id, fields)`, or Convex's `db.patch(id, fields)`. */
  async patch(a: string, b: string | Record<string, unknown>, c?: Record<string, unknown>) {
    if (c === undefined) {
      const table = this.tableOfIdArg(a, "db.patch");
      if (table === undefined) throw new Error(`Update on nonexistent document ID ${a}`);
      return this.patchIn(table, a, b as Record<string, unknown>);
    }
    return this.patchIn(a, b as string, c);
  }

  private async patchIn(table: string, id: string, fields: Record<string, unknown>) {
    const t = this.findTable(table);
    const cur = await this.read(table, id, "db.patch");
    if (!cur || !t) throw new Error(`Update on nonexistent document ID ${id}`);
    const old = this.writes.get(id)?.old ?? cur;
    // Convex's shallow merge: a field set to `undefined` is removed.
    const next: Record<string, unknown> = { ...cur };
    for (const [k, v] of Object.entries(fields)) if (v === undefined) delete next[k];
    Object.assign(next, copyFields(fields, "patch"));
    checkSystemFields(next, fields, id, cur._creationTime);
    this.stage(t, id, old, sortFields({ ...next, _id: id, _creationTime: cur._creationTime } as Doc));
  }

  /** Convex's `db.replace(table, id, value)` or `db.replace(id, value)`: every non-system field is replaced. */
  async replace(a: string, b: string | Record<string, unknown>, c?: Record<string, unknown>) {
    if (c === undefined) {
      const table = this.tableOfIdArg(a, "db.replace");
      if (table === undefined) throw new Error(`Replace on nonexistent document ID ${a}`);
      return this.replaceIn(table, a, b as Record<string, unknown>);
    }
    return this.replaceIn(a, b as string, c);
  }

  private async replaceIn(table: string, id: string, value: Record<string, unknown>) {
    const t = this.findTable(table);
    const cur = await this.read(table, id, "db.replace");
    if (!cur || !t) throw new Error(`Replace on nonexistent document ID ${id}`);
    const old = this.writes.get(id)?.old ?? cur;
    const next: Record<string, unknown> = {
      ...copyFields(value, "replace"),
      _id: id,
      _creationTime: cur._creationTime,
    };
    checkSystemFields(next, value, id, cur._creationTime);
    this.stage(t, id, old, sortFields(next));
  }

  /** `db.delete(table, id)`, or Convex's `db.delete(id)`. */
  async delete(a: string, b?: string) {
    if (b === undefined) {
      const table = this.tableOfIdArg(a, "db.delete");
      if (table === undefined) throw new Error(`Delete on nonexistent document ID ${a}`);
      return this.deleteIn(table, a);
    }
    return this.deleteIn(a, b);
  }

  private async deleteIn(table: string, id: string) {
    const t = this.findTable(table);
    const cur = await this.read(table, id, "db.delete");
    if (!cur || !t) throw new Error(`Delete on nonexistent document ID ${id}`);
    this.stage(t, id, this.writes.get(id)?.old ?? cur, null);
  }

  /** The writes as persistence rows: the new version of each doc and the index entries that changed. */
  toWrites(): { docs: DocWrite[]; idx: IndexWrite[] } {
    const docs: DocWrite[] = [];
    const idx: IndexWrite[] = [];
    for (const [id, w] of this.writes) {
      docs.push({ table: w.table.id, id, json: w.next ? encodeDoc(w.next) : null });
      for (const ix of w.table.indexes.values()) {
        const oldK = w.old ? indexKey(ix, w.old) : null;
        const newK = w.next ? indexKey(ix, w.next) : null;
        if (oldK && newK && compareKeys(oldK, newK) === 0) {
          // The key did not move; the entry is rewritten so its version (and the write log) reflect
          // the change — a query on this index must see the new document version.
          idx.push({ index: ix.id, key: newK, id });
          continue;
        }
        if (oldK) idx.push({ index: ix.id, key: oldK, id: null });
        if (newK) idx.push({ index: ix.id, key: newK, id });
      }
    }
    return { docs, idx };
  }

  get hasWrites() {
    return this.writes.size > 0;
  }
}

function countRemovals(pend: [Uint8Array, Doc | null][]) {
  let n = 0;
  for (const [, d] of pend) if (d === null) n++;
  return n;
}

/** A validated deep copy of a write's fields (Convex serializes values at the call). */
function copyFields(fields: Record<string, unknown>, method: string): Record<string, unknown> {
  if (!isSimpleObject(fields))
    throw new TypeError(`Invalid argument \`value\` for \`db.${method}\`: expected an object`);
  return copyValue(fields as Value) as Record<string, unknown>;
}

/**
 * As Convex's `ResolvedDocument::new`: `_id` / `_creationTime` in a written value must equal the document's,
 * and no other top-level field may start with an underscore.
 */
function checkSystemFields(
  doc: Record<string, unknown>,
  fields: Record<string, unknown>,
  id: string,
  creationTime: number,
) {
  if ("_id" in fields && fields._id !== undefined && fields._id !== id)
    throw new Error(`Provided document ID "${id}" doesn't match '_id' field ${JSON.stringify(fields._id)}`);
  if ("_creationTime" in fields && fields._creationTime !== undefined && fields._creationTime !== creationTime)
    throw new Error(
      `Provided creation time ${creationTime} doesn't match '_creationTime' field in ${JSON.stringify(fields)}`,
    );
  for (const k of Object.keys(doc))
    if (k.startsWith("_") && k !== "_id" && k !== "_creationTime")
      throw new Error(`Field '${k}' starts with an underscore, which is only allowed for system fields like '_id'`);
}

/** Documents keep their fields sorted by name, as Convex objects do. */
function sortFields(doc: Record<string, unknown>): Doc {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(doc).sort()) out[k] = doc[k];
  return out as Doc;
}

/** A document as stored (Convex's JSON form: $integer, $float, $bytes). */
export const encodeDoc = (doc: Doc): string => JSON.stringify(toJsonValue(doc as unknown as Value));
export const decodeDoc = (json: string): Doc => fromJsonValue(JSON.parse(json)) as unknown as Doc;

const reusedError = () => new Error("This query has been chained with another operator and can't be reused.");

/**
 * `db.query(table)` — one object per link of the chain, with its methods on the prototype (no closures
 * allocated per query: this is the hot path of every read).
 */
class QueryImpl implements TxQuery {
  constructor(
    private readonly tx: Tx,
    private readonly table: string,
    private readonly st: QState,
  ) {}

  private chain(change: (next: QState) => void): TxQuery {
    const st = this.st;
    if (st.iterated) throw new Error("A query can only be chained once and can't be chained after iteration begins.");
    if (st.closed) throw reusedError();
    st.closed = true;
    const next: QState = { ...st, filters: [...st.filters], closed: false, iterated: false, stage: "query" };
    change(next);
    return new QueryImpl(this.tx, this.table, next);
  }

  private results(limit: number) {
    if (this.st.closed || this.st.iterated) throw reusedError();
    this.st.closed = true;
    return this.tx.runQuery(this.st, limit);
  }

  private onlyInitializer(what: string) {
    if (this.st.stage !== "initializer")
      throw new Error(`${what} can only be called on db.query(table), before other operators.`);
  }

  withIndex(name: string, f?: (b: IndexRangeBuilder) => IndexRangeBuilder): TxQuery {
    this.onlyInitializer("withIndex()");
    const t = this.st.t;
    return this.chain((n) => {
      if (!t) return;
      const found = t.indexes.get(name);
      if (!found) throw new Error(`unknown index ${this.table}.${name}`);
      n.ix = found;
      n.range = f ? compileRange(found, f(new IndexRangeBuilder()).exprs) : FULL;
    });
  }

  fullTableScan(): TxQuery {
    this.onlyInitializer("fullTableScan()");
    return this.chain(() => {});
  }

  order(dir: "asc" | "desc"): TxQuery {
    if (this.st.orderSet) throw new Error("Queries may only specify order at most once");
    return this.chain((n) => {
      n.desc = dir === "desc";
      n.orderSet = true;
    });
  }

  filter(predicate: (q: FilterBuilder) => ExpressionOrValue<boolean>): TxQuery {
    if (typeof predicate !== "function") throw new TypeError("Must provide arg 1 `predicate` to `filter`");
    return this.chain((n) => {
      n.filters.push(predicate(filterBuilder));
    });
  }

  take(n: number): Promise<Doc[]> {
    if (n === undefined) throw new TypeError("Must provide arg 1 `n` to `take`");
    if (!Number.isInteger(n) || n < 0) throw new TypeError("Arg 1 `n` to `take` must be a non-negative integer");
    return this.results(n);
  }

  async first(): Promise<Doc | null> {
    return (await this.results(1))[0] ?? null;
  }

  async unique(): Promise<Doc | null> {
    const two = await this.results(2);
    if (two.length > 1)
      throw new Error(
        `unique() query returned more than one result from table ${this.table}:\n [${two[0]._id}, ${two[1]._id}, ...]`,
      );
    return two[0] ?? null;
  }

  collect(): Promise<Doc[]> {
    // No cap: everything in the range, bounded only by the transaction's read limit (one row past it is
    // enough to raise Convex's error).
    return this.results(this.tx.collectLimit());
  }

  paginate(opts: PaginationOptions): Promise<PaginationResult> {
    if (this.st.closed || this.st.iterated) throw reusedError();
    this.st.closed = true;
    return this.tx.paginate(this.table, this.st, opts);
  }

  [Symbol.asyncIterator](): AsyncIterator<Doc> {
    if (this.st.iterated) throw new Error("Iteration can only begin on a query once.");
    if (this.st.closed) throw reusedError();
    this.st.iterated = true;
    return this.tx.iterate(this.st);
  }
}
