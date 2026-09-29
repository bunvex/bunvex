// The DECLARED schema: table names and the indexes the app asks for. It carries no ids: the numbers that
// persistence stores are assigned once and kept in the `_tables` / `_index` system tables, and each Engine
// resolves them into its own catalog (catalog.ts, STUDY-04). Every table also gets Convex's two system
// indexes, `by_id` and `by_creation_time`.
import { encodeKey, type KeyValue } from "./keyenc.ts";

export type FieldValue = null | boolean | number | string;
export type Doc = { _id: string; _creationTime: number; [k: string]: unknown };

/** A resolved index: `id` is the persistence index id (PERSIST-01 C1). */
export type IndexDef = { id: number; table: string; name: string; fields: string[] };
/** A resolved table: `id` is the persistence table id ("tablet"), `number` the Convex table number. */
export type TableDef = { id: number; number: number; name: string; indexes: Map<string, IndexDef>; byId: IndexDef };

export type DeclaredTable = { name: string; indexes: Record<string, string[]> };

export const SYSTEM_INDEXES: Record<string, string[]> = { by_id: ["_id"], by_creation_time: ["_creationTime"] };

const MAX_IDENTIFIER_LEN = 64;
/** Convex's identifier rule: ≤ 64 chars, an ASCII letter or `_` first, then letters, digits or `_`. */
export function checkIdentifier(kind: string, s: string) {
  if (s.length === 0 || s.length > MAX_IDENTIFIER_LEN || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s) || !/[A-Za-z0-9]/.test(s))
    throw new Error(
      `Invalid ${kind} name "${s}": use at most ${MAX_IDENTIFIER_LEN} ASCII letters, digits and underscores, starting with a letter or underscore.`,
    );
}

export class Schema {
  tables = new Map<string, DeclaredTable>();

  table(name: string, indexes: Record<string, string[]>) {
    checkIdentifier("table", name);
    if (name.startsWith("_")) throw new Error(`Invalid table name "${name}": names starting with "_" are reserved.`);
    if (this.tables.has(name)) throw new Error(`Duplicate table "${name}".`);
    for (const [n, fields] of Object.entries(indexes)) {
      checkIdentifier("index", n);
      if (n in SYSTEM_INDEXES || n.startsWith("_"))
        throw new Error(`Invalid index name "${name}.${n}": the name is reserved.`);
      if (fields.length === 0) throw new Error(`Index "${name}.${n}" must have at least one field.`);
    }
    this.tables.set(name, { name, indexes: { ...indexes } });
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
