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
} from "@bunvex/values";
import BTree from "sorted-btree";
import type { Catalog } from "./catalog.ts";
import type { Interval } from "./committer.ts";
import { nextUp, outsideExecution, wallClock } from "./determinism.ts";
import { compareKeys, encodeKey, type KeyValue, prefixEnd } from "./keyenc.ts";
import type { DocWrite, IndexWrite, Persistence, ScanDocs } from "./persistence/index.ts";
import { type Doc, type IndexDef, indexKey, type TableDef } from "./schema.ts";

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

/** Convex's per-transaction read limits (crates/common/src/knobs.rs). System transactions are exempt. */
export const TRANSACTION_MAX_READ_SIZE_ROWS = 32_000;
export const TRANSACTION_MAX_READ_SIZE_BYTES = 1 << 24; // 16 MiB
export const TRANSACTION_MAX_READ_SET_INTERVALS = 4096;
const OVER_LIMIT_HELP =
  "Consider using smaller limits in your queries, paginating your queries, or using indexed queries with a selective index range expressions.";

export class Tx {
  reads: Interval[] = [];
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
    if (name.startsWith("_") && !this.system) throw new Error(`System table ${name} is not accessible here.`);
    return this.catalog.table(name);
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

  async get(table: string, id: string): Promise<Doc | null> {
    return this.read(table, id, "db.get");
  }

  private async read(table: string, id: string, method: string): Promise<Doc | null> {
    const t = this.tableDef(table);
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

  query(table: string) {
    const t = this.tableDef(table);
    let ix = t.indexes.get("by_creation_time")!;
    let range: Range = FULL;
    let desc = false;
    const snapshotRange = async (limit: number): Promise<Doc[]> => {
      const p = this.persistence as Persistence & Partial<ScanDocs>;
      if (p.scanDocs) {
        // Remote persistence fuses the index range and the document fetches into one round trip.
        const rows = await outsideExecution(() =>
          p.scanDocs!(t.id, ix.id, range.lo, range.hi, this.snapshot, limit, desc),
        );
        for (const j of rows) this.recordDoc(j);
        return rows.map(decodeDoc);
      }
      const ids = await outsideExecution(() =>
        this.persistence.scan(ix.id, range.lo, range.hi, this.snapshot, limit, desc),
      );
      const out: Doc[] = [];
      for (const id of ids) {
        const json = await outsideExecution(() => this.persistence.get(t.id, id, this.snapshot));
        if (json) {
          this.recordDoc(json);
          out.push(decodeDoc(json));
        }
      }
      return out;
    };
    const run = async (limit: number): Promise<Doc[]> => {
      if (limit <= 0) return [];
      // Read-set = the whole scanned interval (a take(n) could narrow it to what was read; that only
      // affects how often the query cache is invalidated, never correctness).
      this.recordInterval({ index: ix.id, lo: range.lo, hi: range.hi });
      const pend: [Uint8Array, Doc | null][] = [];
      this.pending.get(ix.id)?.forRange(range.lo, range.hi, false, (k, v) => {
        pend.push([k, v]);
      });
      if (pend.length === 0) return snapshotRange(limit); // the common case: nothing written here
      return this.mergePending(ix, pend, await snapshotRange(limit + countRemovals(pend)), limit, desc);
    };
    const q = {
      withIndex(name: string, f?: (b: IndexRangeBuilder) => IndexRangeBuilder) {
        const found = t.indexes.get(name);
        if (!found) throw new Error(`unknown index ${table}.${name}`);
        ix = found;
        range = f ? compileRange(found, f(new IndexRangeBuilder()).exprs) : FULL;
        return q;
      },
      order(dir: "asc" | "desc") {
        desc = dir === "desc";
        return q;
      },
      take: (n: number) => {
        if (n === undefined) throw new TypeError("Must provide arg 1 `n` to `take`");
        if (!Number.isInteger(n) || n < 0) throw new TypeError("Arg 1 `n` to `take` must be a non-negative integer");
        return run(n);
      },
      first: async () => (await run(1))[0] ?? null,
      // No cap: everything in the range, bounded only by the transaction's read limit (one row past it is
      // enough to raise Convex's error).
      collect: () => run(this.system ? 1_000_000 : TRANSACTION_MAX_READ_SIZE_ROWS - this.docsRead + 1),
    };
    return q;
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

  /** Validators of the declared tables' documents; set by the engine for mutations (STUDY-14). */
  docValidators: Map<string, GenericValidator> | null = null;

  private stage(t: TableDef, id: string, old: Doc | null, next: Doc | null) {
    if (!this.writable) throw new Error("queries cannot write");
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
    const t = this.tableDef(table);
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

  async patch(table: string, id: string, fields: Record<string, unknown>) {
    const t = this.tableDef(table);
    const cur = await this.read(table, id, "db.patch");
    if (!cur) throw new Error(`patch: ${table}/${id} not found`);
    const old = this.writes.get(id)?.old ?? cur;
    // Convex's shallow merge: a field set to `undefined` is removed.
    const next: Record<string, unknown> = { ...cur };
    for (const [k, v] of Object.entries(fields)) if (v === undefined) delete next[k];
    Object.assign(next, copyFields(fields, "patch"));
    checkSystemFields(next, fields, id, cur._creationTime);
    this.stage(t, id, old, sortFields({ ...next, _id: id, _creationTime: cur._creationTime } as Doc));
  }

  async delete(table: string, id: string) {
    const t = this.tableDef(table);
    const cur = await this.read(table, id, "db.delete");
    if (!cur) return;
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
