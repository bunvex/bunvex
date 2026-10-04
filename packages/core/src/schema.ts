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
/** A search index's configuration (Convex's `SearchIndexConfig`), as stored: its filter fields deduplicated. */
export type SearchIndexDef = { searchField: string; filterFields: string[] };
/** A table's search indexes as types (Convex's `GenericTableSearchIndexes`). */
export type GenericTableSearchIndexes = Record<string, { searchField: string; filterFields: string }>;

/** A vector index's configuration (Convex's `VectorIndexConfig`), its filter fields deduplicated. */
export type VectorIndexDef = { vectorField: string; dimensions: number; filterFields: string[] };
/** A table's vector indexes as types (Convex's `GenericTableVectorIndexes`). */
export type GenericTableVectorIndexes = Record<
  string,
  { vectorField: string; dimensions: number; filterFields: string }
>;
/** Convex's MIN_VECTOR_DIMENSIONS, MAX_VECTOR_DIMENSIONS and MAX_VECTOR_INDEX_FILTER_FIELDS_SIZE. */
export const MIN_VECTOR_DIMENSIONS = 2;
export const MAX_VECTOR_DIMENSIONS = 4096;
export const MAX_VECTOR_FILTER_FIELDS = 16;

/** Convex's MAX_TEXT_INDEX_FILTER_FIELDS_SIZE and MAX_INDEXES_PER_TABLE. */
export const MAX_SEARCH_FILTER_FIELDS = 16;
export const MAX_INDEXES_PER_TABLE = 64;

export class TableDefinition<
  // biome-ignore lint/correctness/noUnusedVariables: kept for the data model's types
  DocumentType extends GenericValidator = GenericValidator,
  // biome-ignore lint/correctness/noUnusedVariables: kept for the data model's types
  Indexes extends GenericTableIndexes = {},
  // biome-ignore lint/correctness/noUnusedVariables: kept for the data model's types
  SearchIndexes extends GenericTableSearchIndexes = {},
  // biome-ignore lint/correctness/noUnusedVariables: kept for the data model's types
  VectorIndexes extends GenericTableVectorIndexes = {},
> {
  readonly indexes: Record<string, string[]> = {};
  /** Index names declared more than once (Convex refuses them at push, naming the table: see `defineSchema`). */
  readonly duplicateIndexes: string[] = [];
  /** The indexes declared `staged: true`: built in the background, never enabled until un-staged. */
  readonly staged: string[] = [];
  /** Full-text search indexes (STUDY-45), and those declared `staged: true`. */
  readonly searchIndexes: Record<string, SearchIndexDef> = {};
  readonly stagedSearch: string[] = [];
  /** Vector indexes (STUDY-51), and those declared `staged: true`. */
  readonly vectorIndexes: Record<string, VectorIndexDef> = {};
  readonly stagedVector: string[] = [];
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
  ): TableDefinition<
    DocumentType,
    Expand<Indexes & Record<IndexName, [...Fields, "_creationTime"]>>,
    SearchIndexes,
    VectorIndexes
  >;
  index(name: string, config: string[] | { fields: string[]; staged?: boolean }): this;
  index(name: string, config: string[] | { fields: string[]; staged?: boolean }) {
    const fields = Array.isArray(config) ? config : config?.fields;
    if (!Array.isArray(fields)) throw new Error(`Index "${name}" must be declared with an array of fields.`);
    checkIdentifier("index", name);
    // The other checks need the table's name and run in `defineSchema`, as Convex runs them at push.
    if (name in this.indexes) {
      this.duplicateIndexes.push(name);
      return this;
    }
    this.indexes[name] = [...fields];
    if (!Array.isArray(config) && config.staged === true) this.staged.push(name);
    return this;
  }

  /**
   * Declare a full-text search index (Convex's `searchIndex`, STUDY-45): `searchField` is tokenized, the
   * `filterFields` can be matched with `.eq()` at query time. `staged: true` builds it without enabling it.
   * The checks that need the table's name run in `defineSchema`, as Convex runs them at push.
   */
  searchIndex<
    const IndexName extends string,
    const SearchField extends string,
    const FilterFields extends string = never,
  >(name: IndexName, config: { searchField: SearchField; filterFields?: FilterFields[]; staged: true }): this;
  searchIndex<
    const IndexName extends string,
    const SearchField extends string,
    const FilterFields extends string = never,
  >(
    name: IndexName,
    config: { searchField: SearchField; filterFields?: FilterFields[]; staged?: false },
  ): TableDefinition<
    DocumentType,
    Indexes,
    Expand<SearchIndexes & Record<IndexName, { searchField: SearchField; filterFields: FilterFields }>>,
    VectorIndexes
  >;
  searchIndex(name: string, config: { searchField: string; filterFields?: string[]; staged?: boolean }) {
    checkIdentifier("index", name);
    if (typeof config?.searchField !== "string")
      throw new Error(`Search index "${name}" must be declared with a \`searchField\`.`);
    this.searchIndexes[name] = {
      searchField: config.searchField,
      // A set, as Convex's: duplicates are dropped.
      filterFields: [...new Set(config.filterFields ?? [])],
    };
    if (config.staged === true) this.stagedSearch.push(name);
    return this;
  }

  /**
   * Declare a vector index (Convex's `vectorIndex`, STUDY-51): `vectorField` holds arrays of `dimensions`
   * float64s, searched by cosine similarity in actions (`ctx.vectorSearch`); `filterFields` can be matched
   * with `q.eq` / `q.or`. Checked in `defineSchema`, as Convex checks it at push.
   */
  vectorIndex<
    const IndexName extends string,
    const VectorField extends string,
    const FilterFields extends string = never,
  >(
    name: IndexName,
    config: { vectorField: VectorField; dimensions: number; filterFields?: FilterFields[]; staged: true },
  ): this;
  vectorIndex<
    const IndexName extends string,
    const VectorField extends string,
    const FilterFields extends string = never,
  >(
    name: IndexName,
    config: { vectorField: VectorField; dimensions: number; filterFields?: FilterFields[]; staged?: false },
  ): TableDefinition<
    DocumentType,
    Indexes,
    SearchIndexes,
    Expand<
      VectorIndexes & Record<IndexName, { vectorField: VectorField; dimensions: number; filterFields: FilterFields }>
    >
  >;
  vectorIndex(
    name: string,
    config: { vectorField: string; dimensions: number; filterFields?: string[]; staged?: boolean },
  ) {
    checkIdentifier("index", name);
    if (typeof config?.vectorField !== "string")
      throw new Error(`Vector index "${name}" must be declared with a \`vectorField\`.`);
    if (config.dimensions === undefined) throw new Error("Missing dimensions field");
    this.vectorIndexes[name] = {
      vectorField: config.vectorField,
      dimensions: config.dimensions,
      filterFields: [...new Set(config.filterFields ?? [])],
    };
    if (config.staged === true) this.stagedVector.push(name);
    return this;
  }
}

/** The most fields a database index may have, `_creationTime` included (Convex's `MAX_INDEX_FIELDS_SIZE`). */
const MAX_INDEX_FIELDS = 16;
const reservedIndexName = (table: string, n: string) =>
  new Error(
    `In table "${table}" cannot name an index "${n}" because the name is reserved. Indexes may not start with an underscore or be named "by_id" or "by_creation_time".`,
  );

/**
 * Convex's push-time checks of a table's database indexes, in its order and with its messages
 * (`schemas/json.rs` `TableDefinition::try_from`, `indexed_fields.rs`, `index_validation_error.rs`): the
 * number of indexes; each index's fields (at most 16, no `_id`, no repeats); no empty index; no two indexes on
 * the same fields. The names are checked by `checkIndexNames`, the system fields by `checkIndexSystemFields`.
 */
function checkDatabaseIndexes(table: string, t: TableDefinition) {
  const count =
    Object.keys(t.indexes).length +
    t.duplicateIndexes.length +
    Object.keys(t.searchIndexes).length +
    Object.keys(t.vectorIndexes).length;
  if (count > MAX_INDEXES_PER_TABLE)
    throw new Error(`Table "${table}" cannot have more than ${MAX_INDEXES_PER_TABLE} indexes.`);
  const staged = new Set(t.staged);
  const entries = Object.entries(t.indexes);
  for (const group of [false, true]) {
    const mine = entries.filter(([n]) => staged.has(n) === group);
    for (const [n, fields] of mine) {
      const where = `In table "${table}": In index "${n}": `;
      if (fields.length > MAX_INDEX_FIELDS)
        throw new Error(`${where}Indexes may have up to ${MAX_INDEX_FIELDS} fields.`);
      if (fields.includes("_id"))
        throw new Error(`${where}\`_id\` is not a valid index field. To load documents by ID, use \`db.get(id)\`.`);
      const seen = new Set<string>();
      for (const f of fields) {
        if (seen.has(f))
          throw new Error(`${where}Duplicate field "${f}". Index fields must be unique within an index.`);
        seen.add(f);
      }
    }
    for (const [n, fields] of [...mine].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      if (fields.length === 0)
        throw new Error(`In table "${table}" ${group ? "staged " : ""}index "${n}" must have at least one field.`);
  }
  // Convex walks the indexes by name and names the later one first.
  const byFields = new Map<string, string>();
  for (const [n, fields] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const key = JSON.stringify(fields);
    const other = byFields.get(key);
    if (other !== undefined)
      throw new Error(
        `In table "${table}" index "${n}" and index "${other}" have the same fields. Indexes must be unique within a table.`,
      );
    byFields.set(key, n);
  }
}

/** Convex's name checks for database indexes: reserved names, and a name declared twice. */
function checkIndexNames(table: string, t: TableDefinition) {
  for (const n of Object.keys(t.indexes))
    if (n.startsWith("_") || n in SYSTEM_INDEXES) throw reservedIndexName(table, n);
  for (const n of t.duplicateIndexes) throw new Error(`Table "${table}" has two or more definitions of index "${n}".`);
}

/**
 * Convex's last checks, once every table parsed (`Application::_validate_user_defined_index_fields`):
 * `_creationTime` and other system fields are refused, and with `_creationTime` appended an index may not
 * pass 16 fields. Convex's `_creationTime` message ends with a docs link, left out (DV-04).
 */
function checkIndexSystemFields(t: TableDefinition) {
  const staged = new Set(t.staged);
  const sorted = (group: boolean) =>
    Object.entries(t.indexes)
      .filter(([n]) => staged.has(n) === group)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [, fields] of [...sorted(false), ...sorted(true)]) {
    if (fields.includes("_creationTime"))
      throw new Error(
        "`_creationTime` is automatically added to the end of each index. It should not be added explicitly in the index definition.",
      );
    if (fields.some((f) => f.split(".").some((part) => part.startsWith("_"))))
      throw new Error("Reserved fields (starting with `_`) are not allowed in indexes.");
    if (fields.length + 1 > MAX_INDEX_FIELDS) throw new Error(`Indexes may have up to ${MAX_INDEX_FIELDS} fields.`);
  }
}

/** Convex's push-time checks of a table's vector indexes (`schemas/json.rs`, `dimensions.rs`). */
function checkVectorIndexes(table: string, t: TableDefinition) {
  const others = new Set([...Object.keys(t.indexes), ...Object.keys(t.searchIndexes)]);
  const seen = new Map<string, string>();
  for (const [n, d] of Object.entries(t.vectorIndexes)) {
    if (n.startsWith("_") || n in SYSTEM_INDEXES)
      throw new Error(
        `In table "${table}" cannot name an index "${n}" because the name is reserved. Indexes may not start with an underscore or be named "by_id" or "by_creation_time".`,
      );
    if (others.has(n)) throw new Error(`Table "${table}" has two or more definitions of index "${n}".`);
    for (const f of [d.vectorField, ...d.filterFields])
      if (!FIELD_PATH.test(f)) throw new Error(`In index "${n}": Invalid index field: "${f}"`);
    if (!Number.isInteger(d.dimensions) || d.dimensions < MIN_VECTOR_DIMENSIONS || d.dimensions > MAX_VECTOR_DIMENSIONS)
      throw new Error(
        `Dimensions ${d.dimensions} must be between ${MIN_VECTOR_DIMENSIONS} and ${MAX_VECTOR_DIMENSIONS}.`,
      );
    // Convex's message says "Search indexes" for vector indexes too.
    if (d.filterFields.length > MAX_VECTOR_FILTER_FIELDS)
      throw new Error(`Search indexes may have up to ${MAX_VECTOR_FILTER_FIELDS} filter fields.`);
    const key = `${d.vectorField}\u0000${d.dimensions}`;
    const other = seen.get(key);
    if (other !== undefined)
      throw new Error(
        `In table "${table}" vector index "${other}" and vector index "${n}" have the same \`vectorField\`. Vector index fields must be unique within a table. You should combine the\n             indexes with the same \`vectorField\` into one index containing all \`filterField\`s and then use different subsets of the \`filterField\`s at query time.`,
      );
    seen.set(key, n);
  }
}

/** A dotted path of identifiers (Convex's `FieldPath`). */
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** Convex's push-time checks of a table's search indexes (`schemas/json.rs`, `index_validation_error.rs`). */
function checkSearchIndexes(table: string, t: TableDefinition) {
  for (const n of Object.keys(t.searchIndexes)) {
    if (n.startsWith("_") || n in SYSTEM_INDEXES)
      throw new Error(
        `In table "${table}" cannot name an index "${n}" because the name is reserved. Indexes may not start with an underscore or be named "by_id" or "by_creation_time".`,
      );
    if (n in t.indexes) throw new Error(`Table "${table}" has two or more definitions of index "${n}".`);
  }
  const seen = new Map<string, string>();
  for (const [n, d] of Object.entries(t.searchIndexes)) {
    for (const f of [d.searchField, ...d.filterFields])
      if (!FIELD_PATH.test(f)) throw new Error(`In index "${n}": Invalid index field: "${f}"`);
    if (d.filterFields.length > MAX_SEARCH_FILTER_FIELDS)
      throw new Error(`Search indexes may have up to ${MAX_SEARCH_FILTER_FIELDS} filter fields.`);
    // Two search indexes on the same field and the same filter fields (Convex compares the pair; its message,
    // stray line break included, names the field).
    const key = JSON.stringify([d.searchField, [...d.filterFields].sort()]);
    const other = seen.get(key);
    if (other !== undefined)
      throw new Error(
        `In table "${table}" search index "${other}" and search index "${n}" have the same \`searchField\`. Search index fields must be unique within a table. You should combine the\n             indexes with the same \`searchField\` into one index containing all \`filterField\`s and then use different subsets of the \`filterField\`s at query time.`,
      );
    seen.set(key, n);
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
  /** Full-text search indexes (STUDY-45), and the names of those declared staged. */
  searchIndexes?: Record<string, SearchIndexDef>;
  stagedSearch?: string[];
  /** Vector indexes (STUDY-51), and the names of those declared staged. */
  vectorIndexes?: Record<string, VectorIndexDef>;
  stagedVector?: string[];
};
/** A schema's tables as types (Convex's `GenericSchema`). */
export type GenericSchema = Record<
  string,
  TableDefinition<GenericValidator, GenericTableIndexes, GenericTableSearchIndexes, GenericTableVectorIndexes>
>;
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
    checkDatabaseIndexes(name, t);
    checkSearchIndexes(name, t);
    checkVectorIndexes(name, t);
    checkIndexNames(name, t);
    out.set(name, {
      name,
      indexes: { ...t.indexes },
      document: t.document,
      staged: [...t.staged],
      ...(Object.keys(t.searchIndexes).length
        ? { searchIndexes: structuredClone(t.searchIndexes), stagedSearch: [...t.stagedSearch] }
        : {}),
      ...(Object.keys(t.vectorIndexes).length
        ? { vectorIndexes: structuredClone(t.vectorIndexes), stagedVector: [...t.stagedVector] }
        : {}),
    });
  }
  for (const t of Object.values(tables)) checkIndexSystemFields(t);
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
