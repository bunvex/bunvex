// A transaction: reads at a snapshot, records its read-set, buffers its writes, and turns them into
// persistence rows (document versions + the index entries that changed).
import type { Interval } from "./committer.ts";
import { compareKeys, encodeKey, type KeyValue, prefixEnd } from "./keyenc.ts";
import type { DocWrite, IndexWrite, Persistence, ScanDocs } from "./persistence/index.ts";
import { type Doc, indexKey, type Schema, type TableDef } from "./schema.ts";

type Range = { lo: Uint8Array; hi: Uint8Array };
const FULL: Range = { lo: new Uint8Array(0), hi: Uint8Array.from([0xff, 0xff, 0xff, 0xff]) };

export class IndexRangeBuilder {
  private eqs: KeyValue[] = [];
  private lower: { v: KeyValue; incl: boolean } | null = null;
  private upper: { v: KeyValue; incl: boolean } | null = null;
  eq(_field: string, v: KeyValue) {
    this.eqs.push(v);
    return this;
  }
  gt(_f: string, v: KeyValue) {
    this.lower = { v, incl: false };
    return this;
  }
  gte(_f: string, v: KeyValue) {
    this.lower = { v, incl: true };
    return this;
  }
  lt(_f: string, v: KeyValue) {
    this.upper = { v, incl: false };
    return this;
  }
  lte(_f: string, v: KeyValue) {
    this.upper = { v, incl: true };
    return this;
  }
  /** Fields are consumed in index order (eq… then one range), as in Convex. */
  range(): Range {
    const prefix = encodeKey(this.eqs);
    let lo = prefix;
    let hi = prefixEnd(prefix);
    if (this.lower) {
      const k = encodeKey([...this.eqs, this.lower.v]);
      lo = this.lower.incl ? k : prefixEnd(k);
    }
    if (this.upper) {
      const k = encodeKey([...this.eqs, this.upper.v]);
      hi = this.upper.incl ? prefixEnd(k) : k;
    }
    if (this.eqs.length === 0 && !this.lower) lo = FULL.lo;
    if (this.eqs.length === 0 && !this.upper) hi = FULL.hi;
    return { lo, hi };
  }
}

export class Tx {
  reads: Interval[] = [];
  private writes = new Map<string, { table: TableDef; old: Doc | null; next: Doc | null }>();
  constructor(
    private schema: Schema,
    private persistence: Persistence,
    readonly snapshot: number,
    private readonly writable: boolean,
  ) {}

  private tableDef(name: string) {
    const t = this.schema.tables.get(name);
    if (!t) throw new Error(`unknown table ${name}`);
    return t;
  }

  async get(table: string, id: string): Promise<Doc | null> {
    const t = this.tableDef(table);
    const w = this.writes.get(id);
    if (w) return w.next;
    const k = encodeKey([id]);
    this.reads.push({ index: t.byId.id, lo: k, hi: prefixEnd(k) });
    const json = await this.persistence.get(t.id, id, this.snapshot);
    return json ? (JSON.parse(json) as Doc) : null;
  }

  query(table: string) {
    const t = this.tableDef(table);
    let ix = t.indexes.get("by_creation_time")!;
    let range: Range = FULL;
    let desc = false;
    const run = async (limit: number): Promise<Doc[]> => {
      // Read-set = the whole scanned interval (a take(n) could narrow it to what was read; that only
      // affects how often the query cache is invalidated, never correctness).
      this.reads.push({ index: ix.id, lo: range.lo, hi: range.hi });
      const p = this.persistence as Persistence & Partial<ScanDocs>;
      if (p.scanDocs) {
        // Remote persistence fuses the index range and the document fetches into one round trip.
        const rows = await p.scanDocs(t.id, ix.id, range.lo, range.hi, this.snapshot, limit, desc);
        return rows.map((j) => JSON.parse(j) as Doc);
      }
      const ids = await this.persistence.scan(ix.id, range.lo, range.hi, this.snapshot, limit, desc);
      const out: Doc[] = [];
      for (const id of ids) {
        const json = await this.persistence.get(t.id, id, this.snapshot);
        if (json) out.push(JSON.parse(json) as Doc);
      }
      return out;
    };
    const q = {
      withIndex(name: string, f?: (b: IndexRangeBuilder) => IndexRangeBuilder) {
        const found = t.indexes.get(name);
        if (!found) throw new Error(`unknown index ${table}.${name}`);
        ix = found;
        if (f) range = f(new IndexRangeBuilder()).range();
        return q;
      },
      order(dir: "asc" | "desc") {
        desc = dir === "desc";
        return q;
      },
      take: (n: number) => run(n),
      first: async () => (await run(1))[0] ?? null,
      collect: () => run(8192),
    };
    return q;
  }

  private stage(t: TableDef, id: string, old: Doc | null, next: Doc | null) {
    if (!this.writable) throw new Error("queries cannot write");
    const prev = this.writes.get(id);
    this.writes.set(id, { table: t, old: prev ? prev.old : old, next });
  }

  async insert(table: string, fields: Record<string, unknown>): Promise<string> {
    const t = this.tableDef(table);
    const id = crypto.randomUUID();
    this.stage(t, id, null, { ...fields, _id: id, _creationTime: Date.now() } as Doc);
    return id;
  }

  async patch(table: string, id: string, fields: Record<string, unknown>) {
    const t = this.tableDef(table);
    const cur = await this.get(table, id);
    if (!cur) throw new Error(`patch: ${table}/${id} not found`);
    const old = this.writes.get(id)?.old ?? cur;
    this.stage(t, id, old, { ...cur, ...fields, _id: id, _creationTime: cur._creationTime });
  }

  async delete(table: string, id: string) {
    const t = this.tableDef(table);
    const cur = await this.get(table, id);
    if (!cur) return;
    this.stage(t, id, this.writes.get(id)?.old ?? cur, null);
  }

  /** The writes as persistence rows: the new version of each doc and the index entries that changed. */
  toWrites(): { docs: DocWrite[]; idx: IndexWrite[] } {
    const docs: DocWrite[] = [];
    const idx: IndexWrite[] = [];
    for (const [id, w] of this.writes) {
      docs.push({ table: w.table.id, id, json: w.next ? JSON.stringify(w.next) : null });
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
