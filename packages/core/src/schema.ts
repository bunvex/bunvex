// The DECLARED schema (Convex's `defineSchema` / `defineTable`, STUDY-14): table names, their document
// validators and the indexes the app asks for. It carries no ids: the numbers that
// persistence stores are assigned once and kept in the `_tables` / `_index` system tables, and each Engine
// resolves them into its own catalog (catalog.ts, STUDY-04). Every table also gets Convex's two system
// indexes, `by_id` and `by_creation_time`.
import {
  type GenericValidator,
  isBytes,
  type ObjectType,
  type PropertyValidators,
  type ValidatorJSON,
  type VObject,
  v,
} from "@bunvex/values";
import { encodeKey, type KeyValue } from "./keyenc.ts";

export type FieldValue = null | boolean | number | string;
/** Flatten an intersection for display (Convex's `Expand`). */
export type Expand<T> = T extends object ? { [K in keyof T]: T[K] } : T;
export type Doc = { _id: string; _creationTime: number; [k: string]: unknown };

/**
 * A resolved index: `id` is the persistence index id (PERSIST-01 C1). `metaId` is its `_index` document
 * (absent for the bootstrap tables' indexes); `staged` marks a staged pending index; `readyTs` is the commit
 * that enabled it while this process ran: a snapshot older than that must not read it (0: enabled at load).
 */
export type IndexDef = {
  id: number;
  table: string;
  name: string;
  fields: string[];
  metaId?: string;
  staged?: boolean;
  readyTs?: number;
  /** The read of its `_index` document a query records (built on first use; never mutated). */
  metaRead?: { index: number; lo: Uint8Array; hi: Uint8Array };
};
/**
 * A resolved table: `id` is the persistence table id ("tablet"), `number` the Convex table number.
 * `indexes` are the ENABLED indexes, by name: what queries use. `pending` are the indexes being built
 * (backfilling, or backfilled and not yet enabled): every write maintains them, no query reads them
 * (Convex's `IndexRegistry` enabled / pending split, STUDY-29).
 */
export type TableDef = {
  id: number;
  number: number;
  name: string;
  /** Its `_tables` document's id: a transaction that uses the table reads it (STUDY-42 PR 2). */
  metaId?: string;
  indexes: Map<string, IndexDef>;
  pending: IndexDef[];
  byId: IndexDef;
};

/** Every index a write must maintain: the enabled ones and the ones being built. */
export function maintainedIndexes(t: TableDef): IndexDef[] {
  const all = [...t.indexes.values()];
  for (const ix of t.pending) all.push(ix);
  return all;
}

export const SYSTEM_INDEXES: Record<string, string[]> = { by_id: ["_id"], by_creation_time: ["_creationTime"] };

const MAX_IDENTIFIER_LEN = 64;
/** Convex's identifier rule: ≤ 64 chars, an ASCII letter or `_` first, then letters, digits or `_`. */
export function checkIdentifier(kind: string, s: string) {
  if (s.length === 0 || s.length > MAX_IDENTIFIER_LEN || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s) || !/[A-Za-z0-9]/.test(s))
    throw new Error(
      `Invalid ${kind} name "${s}": use at most ${MAX_IDENTIFIER_LEN} ASCII letters, digits and underscores, starting with a letter or underscore.`,
    );
}

/** A table's indexes as types: name → its fields, `_creationTime` appended (Convex's). */
export type GenericTableIndexes = Record<string, string[]>;

/**
 * A table of a schema: its document validator and its indexes (Convex's `defineTable(...).index(...)`).
 * The type parameters keep the validator and the indexes for `DataModelFromSchemaDefinition` (STUDY-36).
 */
export class TableDefinition<
  // biome-ignore lint/correctness/noUnusedVariables: kept for the data model's types
  DocumentType extends GenericValidator = GenericValidator,
  // biome-ignore lint/correctness/noUnusedVariables: kept for the data model's types
  Indexes extends GenericTableIndexes = {},
> {
  readonly indexes: Record<string, string[]> = {};
  /** The indexes declared `staged: true`: built in the background, never enabled until un-staged. */
  readonly staged: string[] = [];
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
  /**
   * Declare an index on `fields` (Convex appends `_creationTime` and `_id`). As Convex's, the second
   * argument may also be `{ fields, staged }`: a staged index is backfilled but not enabled (queries on it
   * fail) until a later schema declares it without `staged`.
   */
  index<IndexName extends string, const Fields extends [string, ...string[]]>(
    name: IndexName,
    config: Fields | { fields: Fields; staged?: boolean },
  ): TableDefinition<DocumentType, Expand<Indexes & Record<IndexName, [...Fields, "_creationTime"]>>>;
  index(name: string, config: string[] | { fields: string[]; staged?: boolean }): this;
  index(name: string, config: string[] | { fields: string[]; staged?: boolean }) {
    const fields = Array.isArray(config) ? config : config?.fields;
    if (!Array.isArray(fields)) throw new Error(`Index "${name}" must be declared with an array of fields.`);
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
    if (!Array.isArray(config) && config.staged === true) this.staged.push(name);
    return this;
  }
}

/** Convex's `defineTable`: a document validator (or an object of field validators). */
export function defineTable<D extends GenericValidator>(document: D): TableDefinition<D>;
export function defineTable<F extends PropertyValidators>(fields: F): TableDefinition<VObject<ObjectType<F>, F>>;
export function defineTable(document: GenericValidator | PropertyValidators): TableDefinition {
  return new TableDefinition(document);
}

export type DeclaredTable = {
  name: string;
  indexes: Record<string, string[]>;
  document: GenericValidator;
  /** Names of `indexes` declared staged. */
  staged?: string[];
};
/** A schema's tables as types (Convex's `GenericSchema`). */
export type GenericSchema = Record<string, TableDefinition<GenericValidator, GenericTableIndexes>>;
/**
 * A schema: its tables at run time, and (as types only) the definitions they came from and whether table
 * names are strict, for `DataModelFromSchemaDefinition` (STUDY-36).
 */
export type SchemaDefinition<
  Schema extends GenericSchema = GenericSchema,
  StrictTableTypes extends boolean = boolean,
> = {
  tables: Map<string, DeclaredTable>;
  schemaValidation: boolean;
  /** Types only: never set at run time. */
  readonly __tables?: Schema;
  readonly __strictTableNameTypes?: StrictTableTypes;
};

/**
 * Convex's `defineSchema`. With `schemaValidation` (the default), every document written to a declared
 * table must match its validator (with `_id` and `_creationTime` added); tables not declared accept anything.
 */
export function defineSchema<Schema extends GenericSchema, StrictTableNameTypes extends boolean = true>(
  tables: Schema,
  options: { schemaValidation?: boolean; strictTableNameTypes?: StrictTableNameTypes } = {},
): SchemaDefinition<Schema, StrictTableNameTypes> {
  const out = new Map<string, DeclaredTable>();
  for (const [name, t] of Object.entries(tables)) {
    checkIdentifier("table", name);
    if (name.startsWith("_")) throw new Error(`Invalid table name "${name}": names starting with "_" are reserved.`);
    if (!(t instanceof TableDefinition)) throw new Error(`Table "${name}" must be defined with defineTable(...).`);
    out.set(name, { name, indexes: { ...t.indexes }, document: t.document, staged: [...t.staged] });
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
    if (v === null || typeof v !== "object" || Array.isArray(v) || isBytes(v)) return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  return v as KeyValue;
}

/**
 * An index key, as Convex's `IndexKey::to_bytes`: the indexed values (a missing field is `undefined`, below
 * `null`), then the `_id` as a string value — unique, and the final tiebreaker.
 */
export function indexKey(ix: IndexDef, doc: Doc): Uint8Array {
  return encodeKey(indexKeyValues(ix, doc));
}

/** The values `indexKey` encodes, in order. */
export function indexKeyValues(ix: IndexDef, doc: Doc): KeyValue[] {
  const vals: KeyValue[] = ix.name === "by_id" ? [] : ix.fields.map((f) => fieldValue(doc, f));
  vals.push(doc._id);
  return vals;
}

/** Table names a document validator points to with `v.id` (Convex's `foreign_keys`). */
export function referencedTables(v: ValidatorJSON, out = new Set<string>()): Set<string> {
  switch (v.type) {
    case "id":
      out.add(v.tableName);
      break;
    case "array":
      referencedTables(v.value, out);
      break;
    case "object":
      for (const f of Object.values(v.value)) referencedTables(f.fieldType, out);
      break;
    case "record":
      referencedTables(v.keys, out);
      referencedTables(v.values.fieldType, out);
      break;
    case "union":
      for (const u of v.value) referencedTables(u, out);
      break;
  }
  return out;
}
