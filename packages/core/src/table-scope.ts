// `db.table(name)` (STUDY-66 §2), as Convex's `TableReader` / `TableWriter`
// (npm-packages/convex/src/server/impl/database_impl.ts): the database scoped to one table. Each method is the
// two-argument form with the table filled in, so validation and errors are those of `db.get(table, id)`,
// `db.patch(table, id, value)`, … — after Convex's own argument checks, which the scoped forms need: a
// missing `id` or `value` must not turn a two-argument call into the one-argument form.
import type { Doc } from "./schema.ts";
import type { TxQuery } from "./tx.ts";

/** What a table reader needs of a database (`Tx`, or `db.system`). */
type Reader = {
  get(table: string, id: string): Promise<Doc | null>;
  query(table: string): TxQuery;
};
type Writer = Reader & {
  insert(table: string, value: Record<string, unknown>): Promise<string>;
  patch(table: string, id: string, value: Record<string, unknown>): Promise<void>;
  replace(table: string, id: string, value: Record<string, unknown>): Promise<void>;
  delete(table: string, id: string): Promise<void>;
};

/** Convex's `validateArg` (impl/validate.ts). */
function required(arg: unknown, idx: number, method: string, name: string) {
  if (arg === undefined) throw new TypeError(`Must provide arg ${idx} \`${name}\` to \`${method}\``);
}

export class TableReader {
  constructor(
    protected readonly db: Reader,
    protected readonly tableName: string,
  ) {}

  async get(id: string): Promise<Doc | null> {
    required(id, 1, "get", "id");
    return this.db.get(this.tableName, id);
  }

  query(): TxQuery {
    return this.db.query(this.tableName);
  }
}

export class TableWriter extends TableReader {
  private get writer() {
    return this.db as Writer;
  }

  async insert(value: Record<string, unknown>): Promise<string> {
    required(value, 2, "insert", "value");
    return this.writer.insert(this.tableName, value);
  }

  async patch(id: string, value: Record<string, unknown>): Promise<void> {
    required(id, 1, "patch", "id");
    required(value, 2, "patch", "value");
    return this.writer.patch(this.tableName, id, value);
  }

  async replace(id: string, value: Record<string, unknown>): Promise<void> {
    required(id, 1, "replace", "id");
    required(value, 2, "replace", "value");
    return this.writer.replace(this.tableName, id, value);
  }

  async delete(id: string): Promise<void> {
    required(id, 1, "delete", "id");
    return this.writer.delete(this.tableName, id);
  }
}
