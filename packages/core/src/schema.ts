// Tables and their indexes. Every table gets Convex's two system indexes, `by_id` and `by_creation_time`,
// before the ones the app declares. Index and table ids are small integers: they are what the
// persistence layer stores (PERSIST-01 C1).
import { encodeKey, type KeyValue } from "./keyenc.ts";

export type FieldValue = null | boolean | number | string;
export type Doc = { _id: string; _creationTime: number; [k: string]: unknown };

export type IndexDef = { id: number; table: string; name: string; fields: string[] };
export type TableDef = { id: number; name: string; indexes: Map<string, IndexDef>; byId: IndexDef };

export class Schema {
  tables = new Map<string, TableDef>();
  private nextIndex = 1;
  private nextTable = 1;

  table(name: string, indexes: Record<string, string[]>) {
    const t: TableDef = { id: this.nextTable++, name, indexes: new Map(), byId: undefined as never };
    t.byId = { id: this.nextIndex++, table: name, name: "by_id", fields: ["_id"] };
    t.indexes.set("by_id", t.byId);
    t.indexes.set("by_creation_time", {
      id: this.nextIndex++,
      table: name,
      name: "by_creation_time",
      fields: ["_creationTime"],
    });
    for (const [n, fields] of Object.entries(indexes))
      t.indexes.set(n, { id: this.nextIndex++, table: name, name: n, fields });
    this.tables.set(name, t);
    return this;
  }
}

const utf8 = new TextEncoder();
/** An index key: the indexed field values, then the _id (unique, and Convex's tiebreaker). */
export function indexKey(ix: IndexDef, doc: Doc): Uint8Array {
  const vals: KeyValue[] = [];
  for (const f of ix.fields) {
    const v = doc[f];
    vals.push(v === undefined ? null : (v as KeyValue));
  }
  if (ix.name !== "by_id") vals.push(utf8.encode(doc._id));
  return encodeKey(vals);
}
