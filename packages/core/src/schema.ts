// The DECLARED schema (Convex's `defineSchema` / `defineTable`, STUDY-14): table names, their document
// validators and the indexes the app asks for. It carries no ids: the numbers that
// persistence stores are assigned once and kept in the `_tables` / `_index` system tables, and each Engine
// resolves them into its own catalog (catalog.ts, STUDY-04). Every table also gets Convex's two system
// indexes, `by_id` and `by_creation_time`.
import { type GenericValidator, type PropertyValidators, v } from "@bunvex/values";
import { encodeKey, type KeyValue } from "./keyenc.ts";

export type FieldValue = null | boolean | number | string;
export type Doc = { _id: string; _creationTime: number; [k: string]: unknown };

/** A resolved index: `id` is the persistence index id (PERSIST-01 C1). */
export type IndexDef = { id: number; table: string; name: string; fields: string[] };
/** A resolved table: `id` is the persistence table id ("tablet"), `number` the Convex table number. */
export type TableDef = { id: number; number: number; name: string; indexes: Map<string, IndexDef>; byId: IndexDef };

export const SYSTEM_INDEXES: Record<string, string[]> = { by_id: ["_id"], by_creation_time: ["_creationTime"] };

const MAX_IDENTIFIER_LEN = 64;
/** Convex's identifier rule: ≤ 64 chars, an ASCII letter or `_` first, then letters, digits or `_`. */
export function checkIdentifier(kind: string, s: string) {
  if (s.length === 0 || s.length > MAX_IDENTIFIER_LEN || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s) || !/[A-Za-z0-9]/.test(s))
    throw new Error(
      `Invalid ${kind} name "${s}": use at most ${MAX_IDENTIFIER_LEN} ASCII letters, digits and underscores, starting with a letter or underscore.`,
    );
}

/** A table of a schema: its document validator and its indexes (Convex's `defineTable(...).index(...)`). */
export class TableDefinition {
  readonly indexes: Record<string, string[]> = {};
  readonly document: GenericValidator;
  constructor(document: GenericValidator | PropertyValidators) {
    this.document = (document as GenericValidator)?.isValidator
      ? (document as GenericValidator)
      : v.object(document as PropertyValidators);
    const d = this.document;
    const ok =
      d.kind === "object" ||
      d.kind === "any" ||
      (d.kind === "union" && (d.members as GenericValidator[]).every((m) => m.kind === "object"));
    if (!ok) throw new Error("A table's document validator must be v.object(...), a v.union of objects, or v.any().");
  }
  /** Declare an index on `fields` (Convex appends `_creationTime` and `_id`). */
  index(name: string, fields: string[]) {
    checkIdentifier("index", name);
    if (name in SYSTEM_INDEXES || name.startsWith("_"))
      throw new Error(`Invalid index name "${name}": the name is reserved.`);
    if (name in this.indexes) throw new Error(`Duplicate index name "${name}".`);
    if (fields.length === 0) throw new Error(`Index "${name}" must have at least one field.`);
    if (fields.length > 16) throw new Error(`Index "${name}" has more than 16 fields.`);
    if (new Set(fields).size !== fields.length) throw new Error(`Index "${name}" has duplicate fields.`);
    for (const f of fields)
      if (f === "_id" || f === "_creationTime" || f.split(".").some((part) => part.startsWith("_")))
        throw new Error(
          `Index "${name}" uses the reserved field "${f}": _id and _creationTime are added to every index automatically, and fields starting with "_" are reserved.`,
        );
    this.indexes[name] = [...fields];
    return this;
  }
}

/** Convex's `defineTable`: a document validator (or an object of field validators). */
export const defineTable = (document: GenericValidator | PropertyValidators) => new TableDefinition(document);

export type DeclaredTable = { name: string; indexes: Record<string, string[]>; document: GenericValidator };
export type SchemaDefinition = { tables: Map<string, DeclaredTable>; schemaValidation: boolean };

/**
 * Convex's `defineSchema`. With `schemaValidation` (the default), every document written to a declared
 * table must match its validator (with `_id` and `_creationTime` added); tables not declared accept anything.
 */
export function defineSchema(
  tables: Record<string, TableDefinition>,
  options: { schemaValidation?: boolean; strictTableNameTypes?: boolean } = {},
): SchemaDefinition {
  const out = new Map<string, DeclaredTable>();
  for (const [name, t] of Object.entries(tables)) {
    checkIdentifier("table", name);
    if (name.startsWith("_")) throw new Error(`Invalid table name "${name}": names starting with "_" are reserved.`);
    if (!(t instanceof TableDefinition)) throw new Error(`Table "${name}" must be defined with defineTable(...).`);
    out.set(name, { name, indexes: { ...t.indexes }, document: t.document });
  }
  return { tables: out, schemaValidation: options.schemaValidation ?? true };
}

/** A table's validator for its stored documents: the declared one with the system fields added. */
export function documentValidator(table: string, doc: GenericValidator): GenericValidator | null {
  const withSystem = (o: GenericValidator) =>
    v.object({ ...(o as { fields: PropertyValidators }).fields, _id: v.id(table), _creationTime: v.number() });
  if (doc.kind === "any") return null;
  if (doc.kind === "object") return withSystem(doc);
  return v.union(...(doc as { members: GenericValidator[] }).members.map(withSystem));
}

/** A field's value at a dotted path (`a.b`), or undefined when any step is missing. */
export function fieldValue(doc: Doc, path: string): KeyValue {
  let v: unknown = doc;
  for (const part of path.split(".")) {
    if (v === null || typeof v !== "object" || Array.isArray(v) || v instanceof ArrayBuffer) return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  return v as KeyValue;
}

/**
 * An index key, as Convex's `IndexKey::to_bytes`: the indexed values (a missing field is `undefined`, below
 * `null`), then the `_id` as a string value — unique, and the final tiebreaker.
 */
export function indexKey(ix: IndexDef, doc: Doc): Uint8Array {
  const vals: KeyValue[] = ix.name === "by_id" ? [] : ix.fields.map((f) => fieldValue(doc, f));
  vals.push(doc._id);
  return encodeKey(vals);
}
