// `db.system` (Convex's `DatabaseReader.system`): read access to the virtual system tables (STUDY-125,
// virtual-tables.ts), `_storage` and `_scheduled_functions`. Each reads its system table (`_file_storage`,
// `_scheduled_jobs`) and gives documents in Convex's virtual shape, with the same ids; only the `by_id` and
// `by_creation_time` indexes are public. No other system table is visible.
import { decodeId } from "@bunvex/values";
import type { ExpressionOrValue, FilterBuilder } from "./filter.ts";
import { opaqueToInspect } from "./inspect.ts";
import type { Doc } from "./schema.ts";
import { TableReader } from "./table-scope.ts";
import type { IndexRangeBuilder, PaginationOptions, PaginationResult, Tx, TxQuery, TxQueryChained } from "./tx.ts";
import { VIRTUAL_INDEXES, VIRTUAL_TABLES, type VirtualTable } from "./virtual-tables.ts";

function virtualTable(table: string): VirtualTable {
  const vt = VIRTUAL_TABLES.get(table);
  if (!vt) throw new Error(`System table ${table} is not accessible here.`);
  return vt;
}

export class SystemReader {
  constructor(private readonly tx: Tx) {}

  /**
   * `db.system.get(id)`, or `db.system.get(table, id)`, as Convex's `1.0/get` with `isSystem`: the id names
   * its table (a virtual one by its system table's number); a user table's is refused, another system
   * table's reads nothing.
   */
  async get(tableOrId: string, id?: string): Promise<Doc | null> {
    const [requested, docId] = id === undefined ? [undefined, tableOrId] : [tableOrId, id];
    let number: number;
    try {
      number = decodeId(docId).tableNumber;
    } catch {
      // An id that does not decode at all is refused with `db.get`'s message, as Convex's `db.system.get`.
      await this.tx.get(docId);
      return null;
    }
    const actual = this.tx.publicTableName(number);
    if (actual === undefined) return null;
    if (!actual.startsWith("_")) throw new Error("User tables cannot be accessed with db.system.");
    const vt = VIRTUAL_TABLES.get(actual);
    if (!vt) return null;
    if (requested !== undefined && requested !== actual)
      throw new Error(
        `Invalid argument \`id\` for \`db.system.get\`: expected to be an Id<"${requested}">, got Id<"${actual}"> instead.`,
      );
    const d = await this.tx.asSystem(() => this.tx.get(vt.system, docId));
    return d && vt.toVirtual(this.tx, d);
  }

  /** `db.system.normalizeId(table, id)`: an id of a virtual table is one of its system table's number. */
  normalizeId(table: string, id: string): string | null {
    const vt = VIRTUAL_TABLES.get(table);
    if (!vt) return null;
    return this.tx.asSystemSync(() => this.tx.normalizeId(vt.system, id));
  }

  /** `db.system.table(name)` (STUDY-66 §2): a reader of one system table. */
  table(name: string): TableReader {
    return new TableReader(this, name);
  }

  query(table: string): TxQuery {
    const vt = virtualTable(table);
    return new VirtualQueryInitializer(
      table,
      this.tx.queryVirtual(table, vt.system, (d) => vt.toVirtual(this.tx, d)),
    );
  }
}

/** A virtual table's query after its first operator (as `QueryImpl`: no index or scan methods). */
export class VirtualQuery implements TxQueryChained {
  constructor(
    protected readonly table: string,
    protected readonly q: TxQueryChained,
  ) {}
  protected wrap(q: TxQueryChained): TxQueryChained {
    return new VirtualQuery(this.table, q);
  }
  order(dir: "asc" | "desc"): TxQueryChained {
    return this.wrap(this.q.order(dir));
  }
  filter(predicate: (q: FilterBuilder) => ExpressionOrValue<boolean>): TxQueryChained {
    return this.wrap(this.q.filter(predicate));
  }
  limit(n: number): TxQueryChained {
    return this.wrap(this.q.limit(n));
  }
  take(n: number): Promise<Doc[]> {
    return this.q.take(n);
  }
  first(): Promise<Doc | null> {
    return this.q.first();
  }
  unique(): Promise<Doc | null> {
    return this.q.unique();
  }
  collect(): Promise<Doc[]> {
    return this.q.collect();
  }
  paginate(opts: PaginationOptions): Promise<PaginationResult> {
    return this.q.paginate(opts);
  }
  [Symbol.asyncIterator](): AsyncIterator<Doc> {
    return this.q[Symbol.asyncIterator]();
  }
}

/** `db.system.query(table)` (as `QueryInitializerImpl`): the only stage that picks an index or a scan. */
export class VirtualQueryInitializer extends VirtualQuery implements TxQuery {
  private get initial(): TxQuery {
    return this.q as TxQuery;
  }
  /** Convex's `virtual_to_system_index`: `by_id` and `by_creation_time` only, the system table's. */
  withIndex(name: string, range?: (b: IndexRangeBuilder) => IndexRangeBuilder): TxQueryChained {
    if (!VIRTUAL_INDEXES.has(name)) throw new Error(`unknown index ${this.table}.${name}`);
    return this.wrap(this.initial.withIndex(name, range));
  }
  /** System tables have no search indexes. */
  withSearchIndex(name: string): TxQueryChained {
    throw new Error(`Index ${this.table}.${name} not found.`);
  }
  fullTableScan(): TxQueryChained {
    return this.wrap(this.initial.fullTableScan());
  }
}

// Printed by name only: `console.log` of one never shows the engine's state (inspect.ts).
opaqueToInspect(SystemReader, VirtualQuery, VirtualQueryInitializer);
