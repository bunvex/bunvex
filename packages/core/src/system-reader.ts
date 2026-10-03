// `db.system` (Convex's `DatabaseReader.system`): read access to the system tables an app may see. They
// come back in their public shape: `_scheduled_functions` (STUDY-30 S2) and `_storage` (STUDY-32 F1). Only the `by_id` and `by_creation_time` indexes are public, as on Convex's virtual tables; the
// other system tables are not visible.
import { decodeId } from "@bunvex/values";
import { SCHEDULED_FUNCTIONS_TABLE, STORAGE_TABLE } from "./catalog.ts";
import type { ExpressionOrValue, FilterBuilder } from "./filter.ts";
import { type JobDoc, publicJob } from "./scheduled-jobs.ts";
import type { Doc } from "./schema.ts";
import { TableReader } from "./table-scope.ts";
import type { IndexRangeBuilder, PaginationOptions, PaginationResult, Tx, TxQuery } from "./tx.ts";

const PUBLIC_INDEXES = new Set(["by_id", "by_creation_time"]);
const VISIBLE: Record<string, (d: Doc) => Doc> = {
  [SCHEDULED_FUNCTIONS_TABLE]: (d) => publicJob(d as unknown as JobDoc) as unknown as Doc,
  // Convex's `_storage` document: base64 sha256, size, and `contentType` null when there is none.
  [STORAGE_TABLE]: (d) =>
    ({
      _id: d._id,
      _creationTime: d._creationTime,
      sha256: d.sha256,
      size: d.size,
      contentType: d.contentType ?? null,
    }) as unknown as Doc,
};

function visible(table: string): (d: Doc) => Doc {
  const project = VISIBLE[table];
  if (!project) throw new Error(`System table ${table} is not accessible here.`);
  return project;
}

export class SystemReader {
  constructor(private readonly tx: Tx) {}

  /** `db.system.get(id)`, or `db.system.get(table, id)`. */
  async get(tableOrId: string, id?: string): Promise<Doc | null> {
    const [table, docId] =
      id === undefined
        ? [Object.keys(VISIBLE).find((t) => this.normalizeId(t, tableOrId) !== null), tableOrId]
        : [tableOrId, id];
    if (table === undefined) {
      // An id that does not decode at all is refused with `db.get`'s message, as Convex's `db.system.get`.
      try {
        decodeId(tableOrId);
      } catch {
        await this.tx.get(tableOrId);
      }
      return null;
    }
    const project = visible(table);
    const d = await this.tx.asSystem(() => this.tx.get(table, docId));
    return d && project(d);
  }

  normalizeId(table: string, id: string): string | null {
    if (!VISIBLE[table]) return null;
    return this.tx.asSystemSync(() => this.tx.normalizeId(table, id));
  }

  /** `db.system.table(name)` (STUDY-66 §2): a reader of one system table. */
  table(name: string): TableReader {
    return new TableReader(this, name);
  }

  query(table: string): TxQuery {
    const project = visible(table);
    return new ProjectedQuery(
      table,
      this.tx.asSystemSync(() => this.tx.query(table)),
      project,
    );
  }
}

class ProjectedQuery implements TxQuery {
  constructor(
    private readonly table: string,
    private readonly q: TxQuery,
    private readonly project: (d: Doc) => Doc,
  ) {}
  private wrap(q: TxQuery) {
    return new ProjectedQuery(this.table, q, this.project);
  }
  withIndex(name: string, range?: (b: IndexRangeBuilder) => IndexRangeBuilder): TxQuery {
    if (!PUBLIC_INDEXES.has(name)) throw new Error(`unknown index ${this.table}.${name}`);
    return this.wrap(this.q.withIndex(name, range));
  }
  /** System tables have no search indexes. */
  withSearchIndex(name: string): TxQuery {
    throw new Error(`Index ${this.table}.${name} not found.`);
  }
  fullTableScan(): TxQuery {
    return this.wrap(this.q.fullTableScan());
  }
  order(dir: "asc" | "desc"): TxQuery {
    return this.wrap(this.q.order(dir));
  }
  filter(predicate: (q: FilterBuilder) => ExpressionOrValue<boolean>): TxQuery {
    return this.wrap(this.q.filter(predicate));
  }
  limit(n: number): TxQuery {
    return this.wrap(this.q.limit(n));
  }
  async take(n: number): Promise<Doc[]> {
    return (await this.q.take(n)).map(this.project);
  }
  async first(): Promise<Doc | null> {
    const d = await this.q.first();
    return d && this.project(d);
  }
  async unique(): Promise<Doc | null> {
    const d = await this.q.unique();
    return d && this.project(d);
  }
  async collect(): Promise<Doc[]> {
    return (await this.q.collect()).map(this.project);
  }
  async paginate(opts: PaginationOptions): Promise<PaginationResult> {
    const r = await this.q.paginate(opts);
    return { ...r, page: r.page.map(this.project) };
  }
  [Symbol.asyncIterator](): AsyncIterator<Doc> {
    const it = this.q[Symbol.asyncIterator]();
    const project = this.project;
    return {
      async next() {
        const r = await it.next();
        return r.done ? r : { done: false, value: project(r.value) };
      },
    };
  }
}
