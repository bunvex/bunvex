// The DECLARED schema (Convex's `defineSchema` / `defineTable`, STUDY-14): table names, their document
// validators and the indexes the app asks for. It carries no ids: the numbers that
// persistence stores are assigned once and kept in the `_tables` / `_index` system tables, and each Engine
// resolves them into its own catalog (catalog.ts, STUDY-04). Every table also gets Convex's two system
// indexes, `by_id` and `by_creation_time`.
import {
  checkValue,
  displayValidator,
  type GenericId,
  type GenericValidator,
  isBytes,
  type ObjectType,
  type PropertyValidators,
  rawValueSize,
  type Validator,
  type ValidatorJSON,
  type Value,
  type VFloat64,
  type VId,
  type VObject,
  type VUnion,
  v,
} from "@bunvex/values";
import { encodeKey, type KeyValue } from "./keyenc.ts";
import type { IndexId, TabletId } from "./persistence/index.ts";

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
  id: IndexId;
  table: string;
  name: string;
  fields: string[];
  metaId?: string;
  staged?: boolean;
  readyTs?: bigint;
  /** The read of its `_index` document a query records (built on first use; never mutated). */
  metaRead?: { index: IndexId; lo: Uint8Array; hi: Uint8Array };
};
/**
 * A resolved table: `id` is the persistence table id ("tablet"), `number` the Convex table number.
 * `indexes` are the ENABLED indexes, by name: what queries use. `pending` are the indexes being built
 * (backfilling, or backfilled and not yet enabled): every write maintains them, no query reads them
 * (Convex's `IndexRegistry` enabled / pending split, STUDY-29).
 */
export type TableDef = {
  id: TabletId;
  number: number;
  name: string;
  /** Its `_tables` document's id: a transaction that uses the table reads it (STUDY-42 PR 2). */
  metaId?: string;
  /** The component whose namespace it is in (its `_components` id); absent for the root's (STUDY-153 PR 2). */
  namespace?: string;
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

/** An index's fields as types (Convex's `GenericIndexFields`). */
export type GenericIndexFields = string[];
/** A table's indexes as types: name → its fields, `_creationTime` appended (Convex's). */
export type GenericTableIndexes = Record<string, GenericIndexFields>;

/**
 * A table of a schema: its document validator and its indexes (Convex's `defineTable(...).index(...)`).
 * The type parameters keep the validator and the indexes for `DataModelFromSchemaDefinition` (STUDY-36).
 */
/** A search index's configuration (Convex's `SearchIndexConfig`), as stored: its filter fields deduplicated. */
export type SearchIndexDef = { searchField: string; filterFields: string[] };
/** A search index as types (Convex's `GenericSearchIndexConfig`): its filter fields a union of their paths. */
export type GenericSearchIndexConfig = { searchField: string; filterFields: string };
/** A table's search indexes as types (Convex's `GenericTableSearchIndexes`). */
export type GenericTableSearchIndexes = Record<string, GenericSearchIndexConfig>;
/** A search index as `searchIndex(name, config)` declares it (Convex's `SearchIndexConfig`). */
export interface SearchIndexConfig<SearchField extends string, FilterFields extends string> {
  searchField: SearchField;
  filterFields?: FilterFields[];
}

/** A vector index's configuration (Convex's `VectorIndexConfig`), its filter fields deduplicated. */
export type VectorIndexDef = { vectorField: string; dimensions: number; filterFields: string[] };
/** A vector index as types (Convex's `GenericVectorIndexConfig`): its filter fields a union of their paths. */
export type GenericVectorIndexConfig = { vectorField: string; dimensions: number; filterFields: string };
/** A table's vector indexes as types (Convex's `GenericTableVectorIndexes`). */
export type GenericTableVectorIndexes = Record<string, GenericVectorIndexConfig>;
/** A vector index as `vectorIndex(name, config)` declares it (Convex's `VectorIndexConfig`). */
export interface VectorIndexConfig<VectorField extends string, FilterFields extends string> {
  vectorField: VectorField;
  dimensions: number;
  filterFields?: FilterFields[];
}
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
  /** @internal Convex's runtime shape, read by libraries (STUDY-181 H-5): the database indexes, not staged, in order. */
  readonly indexes: { indexDescriptor: string; fields: string[] }[] = [];
  /** @internal Convex's runtime shape (STUDY-181 H-5): the database indexes declared `staged: true`, in order. */
  readonly stagedDbIndexes: { indexDescriptor: string; fields: string[] }[] = [];
  /** @internal Convex's runtime shape (STUDY-181 H-5): the search indexes, not staged, in order. */
  readonly searchIndexes: { indexDescriptor: string; searchField: string; filterFields: string[] }[] = [];
  /** @internal Convex's runtime shape (STUDY-181 H-5): the search indexes declared `staged: true`, in order. */
  readonly stagedSearchIndexes: { indexDescriptor: string; searchField: string; filterFields: string[] }[] = [];
  /** @internal Convex's runtime shape (STUDY-181 H-5): the vector indexes, not staged, in order. */
  readonly vectorIndexes: {
    indexDescriptor: string;
    vectorField: string;
    dimensions: number;
    filterFields: string[];
  }[] = [];
  /** @internal Convex's runtime shape (STUDY-181 H-5): the vector indexes declared `staged: true`, in order. */
  readonly stagedVectorIndexes: {
    indexDescriptor: string;
    vectorField: string;
    dimensions: number;
    filterFields: string[];
  }[] = [];
  /**
   * bunvex's own view of the database indexes, by name (the first declaration of a name), staged ones included: what
   * `defineSchema` checks and the engine declares. A name declared twice is in `duplicateIndexes`.
   */
  readonly indexFields: Record<string, string[]> = {};
  /** Index names declared more than once (Convex refuses them at push, naming the table: see `defineSchema`). */
  readonly duplicateIndexes: string[] = [];
  /** The indexes declared `staged: true`: built in the background, never enabled until un-staged. */
  readonly stagedIndexes: string[] = [];
  /** Full-text search indexes by name (STUDY-45), and those declared `staged: true`. */
  readonly searchIndexDefs: Record<string, SearchIndexDef> = {};
  readonly stagedSearch: string[] = [];
  /** Vector indexes by name (STUDY-51), and those declared `staged: true`. */
  readonly vectorIndexDefs: Record<string, VectorIndexDef> = {};
  readonly stagedVector: string[] = [];
  readonly document: GenericValidator;
  /** Convex's name for the table's document validator (`schema.tables.x.validator`, `docValidator`). */
  get validator(): DocumentType {
    return this.document as DocumentType;
  }
  constructor(document: GenericValidator | PropertyValidators) {
    this.document = (document as GenericValidator)?.isValidator
      ? (document as GenericValidator)
      : v.object(document as PropertyValidators);
    // As Convex's `defineTable`, nothing else is checked here: a push refuses a validator a table cannot have
    // (`documentTypeError`, STUDY-14 §6).
  }
  /**
   * Convex's experimental `" indexes"()` (STUDY-144): the table's database indexes, not the staged ones, in the
   * order declared, as `{ indexDescriptor, fields }` (the fields as given, without `_creationTime`).
   */
  " indexes"(): { indexDescriptor: string; fields: string[] }[] {
    return this.indexes;
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
    const staged = !Array.isArray(config) && config.staged === true;
    // Convex's lists, a name declared twice included (the push refuses it), the fields as given.
    (staged ? this.stagedDbIndexes : this.indexes).push({ indexDescriptor: name, fields });
    // The other checks need the table's name and run in `defineSchema`, as Convex runs them at push.
    if (name in this.indexFields) {
      this.duplicateIndexes.push(name);
      return this;
    }
    this.indexFields[name] = [...fields];
    if (staged) this.stagedIndexes.push(name);
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
    // Convex's lists: the filter fields as given (`[]` when absent), a name declared twice listed twice.
    (config.staged === true ? this.stagedSearchIndexes : this.searchIndexes).push({
      indexDescriptor: name,
      searchField: config.searchField,
      filterFields: config.filterFields || [],
    });
    this.searchIndexDefs[name] = {
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
    (config.staged === true ? this.stagedVectorIndexes : this.vectorIndexes).push({
      indexDescriptor: name,
      vectorField: config.vectorField,
      dimensions: config.dimensions,
      filterFields: config.filterFields || [],
    });
    this.vectorIndexDefs[name] = {
      vectorField: config.vectorField,
      dimensions: config.dimensions,
      filterFields: [...new Set(config.filterFields ?? [])],
    };
    if (config.staged === true) this.stagedVector.push(name);
    return this;
  }

  /** The validator `.staged()` proposed, if any. */
  stagedDocument: GenericValidator | undefined = undefined;

  /**
   * @internal Stage the table's next document validator (Convex's `TableDefinition.staged`, STUDY-106): an
   * object of field validators or a validator. It is serialized and stored with the schema, so changing it
   * alone makes a new schema version, but nothing checks documents against it: the validator given to
   * `defineTable` stays the one enforced, and the document type does not change.
   */
  staged(document: Validator<Record<string, unknown>, "required"> | PropertyValidators): this {
    if (this.stagedDocument !== undefined) throw new Error("Table cannot have more than one staged validator.");
    this.stagedDocument = (document as GenericValidator)?.isValidator
      ? (document as GenericValidator)
      : v.object(document as PropertyValidators);
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
    Object.keys(t.indexFields).length +
    t.duplicateIndexes.length +
    Object.keys(t.searchIndexDefs).length +
    Object.keys(t.vectorIndexDefs).length;
  if (count > MAX_INDEXES_PER_TABLE)
    throw new Error(`Table "${table}" cannot have more than ${MAX_INDEXES_PER_TABLE} indexes.`);
  const staged = new Set(t.stagedIndexes);
  const entries = Object.entries(t.indexFields);
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

/**
 * Convex's check when a table definition is exported (`TableDefinition.export`): the staged validator's JSON
 * must be an object. `schemaToJson`, bunvex's `export`, runs it; a push answers it as Convex does (`InvalidSchemaExport`).
 * Convex's message ends with a docs link, left out (DV-356).
 */
export function stagedDocumentJson(staged: GenericValidator): ValidatorJSON {
  const json: unknown = staged.json;
  if (typeof json !== "object")
    throw new Error("Invalid staged validator: please make sure that the parameter of `.staged()` is valid");
  return json as ValidatorJSON;
}

/**
 * Convex's parse of a pushed schema's `stagedDocumentType` (`DocumentSchema::try_from`, json.rs): an object, a
 * union of objects, or `v.any()`, as a table's document validator. The first table's failure (with the
 * offending validator, or the union's offending member), or null. Convex's message ends with a docs link, left
 * out (DV-356).
 */
export function stagedDocumentError(schema: EngineSchema): string | null {
  for (const t of declaredTables(schema).values()) {
    const s = t.stagedDocument;
    if (s === undefined || s.kind === "object" || s.kind === "any") continue;
    const bad = s.kind === "union" ? (s.members as GenericValidator[]).find((m) => m.kind !== "object") : s;
    if (bad)
      return `The document validator in a schema must be an object, a union of objects, or \`v.any()\`. Found ${displayValidator(bad)}.`;
  }
  return null;
}

/** Convex's name checks for database indexes: reserved names, and a name declared twice. */
function checkIndexNames(table: string, t: TableDefinition) {
  for (const n of Object.keys(t.indexFields))
    if (n.startsWith("_") || n in SYSTEM_INDEXES) throw reservedIndexName(table, n);
  for (const n of t.duplicateIndexes) throw new Error(`Table "${table}" has two or more definitions of index "${n}".`);
}

/**
 * Convex's last checks, once every table parsed (`Application::_validate_user_defined_index_fields`):
 * `_creationTime` and other system fields are refused, and with `_creationTime` appended an index may not
 * pass 16 fields. Convex's `_creationTime` message ends with a docs link, left out (DV-04).
 */
function checkIndexSystemFields(t: TableDefinition) {
  const staged = new Set(t.stagedIndexes);
  const sorted = (group: boolean) =>
    Object.entries(t.indexFields)
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
  const others = new Set([...Object.keys(t.indexFields), ...Object.keys(t.searchIndexDefs)]);
  const seen = new Map<string, string>();
  for (const [n, d] of Object.entries(t.vectorIndexDefs)) {
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
  for (const n of Object.keys(t.searchIndexDefs)) {
    if (n.startsWith("_") || n in SYSTEM_INDEXES)
      throw new Error(
        `In table "${table}" cannot name an index "${n}" because the name is reserved. Indexes may not start with an underscore or be named "by_id" or "by_creation_time".`,
      );
    if (n in t.indexFields) throw new Error(`Table "${table}" has two or more definitions of index "${n}".`);
  }
  const seen = new Map<string, string>();
  for (const [n, d] of Object.entries(t.searchIndexDefs)) {
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

/** The validators of the system fields every document has (Convex's `SystemFieldValidators`). */
export type SystemFieldValidators<TableName extends string> = {
  _id: VId<GenericId<TableName>>;
  _creationTime: VFloat64<number>;
};

/** An object validator with the system fields added; any other validator as it is. */
type WithSystemFieldValidators<TableName extends string, D extends GenericValidator> =
  // biome-ignore lint/suspicious/noExplicitAny: any optionality
  D extends VObject<infer Type, infer Fields, any>
    ? VObject<
        Expand<{ _id: GenericId<TableName>; _creationTime: number } & Type>,
        Expand<SystemFieldValidators<TableName> & Fields>
      >
    : D;

/**
 * The validator of a table's whole documents (Convex's `DocValidator`): the table's own, with `_id` and
 * `_creationTime` added — to each member of a union.
 */
export type DocValidator<TableName extends string, D extends GenericValidator> =
  // biome-ignore lint/suspicious/noExplicitAny: any type, any optionality
  D extends VUnion<any, infer Members, any>
    ? { [I in keyof Members]: WithSystemFieldValidators<TableName, Members[I]> } extends infer New extends
        // biome-ignore lint/suspicious/noExplicitAny: any type
        Validator<any, "required">[]
      ? VUnion<WithSystemFieldValidators<TableName, Members[number]>["type"], New>
      : never
    : WithSystemFieldValidators<TableName, D>;

/** The system fields added to a table validator (Convex's `addSystemFields`, STUDY-66 §6). */
function addSystemFields(tableName: string, validator: GenericValidator): GenericValidator {
  switch (validator.kind) {
    case "object":
      return (validator as VObject<unknown, PropertyValidators>).extend({
        _id: v.id(tableName),
        _creationTime: v.number(),
      });
    case "union":
      return v.union(
        ...((validator as VUnion<unknown, GenericValidator[]>).members.map((m) =>
          addSystemFields(tableName, m),
        ) as never[]),
      );
    // `v.any()` already accepts the system fields.
    case "any":
      return validator;
    default:
      throw new Error(
        `Invalid validator for table "${tableName}": a table's documents must be objects, or a union of objects`,
      );
  }
}

/**
 * Convex's `docValidator(tableName, table)`: a validator of the table's whole documents, for `args` and
 * `returns`. `schema.doc(tableName)` is the same, with the table looked up in the schema.
 */
export function docValidator<
  TableName extends string,
  // biome-ignore lint/suspicious/noExplicitAny: any table definition
  Table extends TableDefinition<any, any, any, any>,
>(tableName: TableName, table: Table): DocValidator<TableName, Table["validator"]> {
  return addSystemFields(tableName, table.validator) as DocValidator<TableName, Table["validator"]>;
}

/** What `defineSchema` adds to a schema for its tables' validators (Convex's `SchemaDefinition.doc` / `.id`). */
export type SchemaValidators<Schema extends GenericSchema> = {
  /** The validator of a table's whole documents: its validator with `_id` and `_creationTime`. */
  doc<TableName extends keyof Schema & string>(
    tableName: TableName,
  ): DocValidator<TableName, Schema[TableName]["validator"]>;
  /** `v.id(tableName)`, for a table of this schema only. */
  id<TableName extends keyof Schema & string>(tableName: TableName): VId<GenericId<TableName>>;
};

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
  /** The next document validator `.staged()` proposed (STUDY-106): stored with the schema, never enforced. */
  stagedDocument?: GenericValidator;
};
/** A schema's tables as types (Convex's `GenericSchema`). */
export type GenericSchema = Record<
  string,
  TableDefinition<GenericValidator, GenericTableIndexes, GenericTableSearchIndexes, GenericTableVectorIndexes>
>;
/**
 * A schema (Convex's `SchemaDefinition`, STUDY-144, STUDY-180): `tables`, the record of the `TableDefinition`s it was
 * defined with (`schema.tables.messages.validator`), `schemaValidation`, and `doc` / `id` (`SchemaValidators`).
 * `strictTableNameTypes` is a type only, never set at run time, as Convex's. What the engine reads of a schema is
 * `EngineSchema`, and the tables as it declares them: `declaredTables(schema)`.
 */
export interface SchemaDefinition<Schema extends GenericSchema, StrictTableTypes extends boolean>
  extends SchemaValidators<Schema> {
  tables: Schema;
  /** Types only: never set at run time. */
  strictTableNameTypes: StrictTableTypes;
  readonly schemaValidation: boolean;
}

/**
 * What the engine reads of a schema: its tables and whether documents are validated. Every `SchemaDefinition` is
 * one; so is a schema the engine makes itself (a pushed schema read back, an empty one), which has no `doc` / `id`.
 */
export type EngineSchema = {
  tables: GenericSchema;
  readonly schemaValidation: boolean;
  /** Types only: never set at run time. */
  readonly strictTableNameTypes?: boolean;
};

/** The options of `defineSchema` (Convex's `DefineSchemaOptions`). */
export interface DefineSchemaOptions<StrictTableNameTypes extends boolean> {
  /** Whether documents written are checked against their table's validator (default true). */
  schemaValidation?: boolean;
  /** Types only: false lets the data model name tables the schema does not declare (default true). */
  strictTableNameTypes?: StrictTableNameTypes;
}

/** Each schema's tables as the engine declares them, made once. */
const declared = new WeakMap<object, Map<string, DeclaredTable>>();

/**
 * The tables of a schema as the engine reads them (by name: their indexes, search and vector indexes, staged ones,
 * document validator), made from its `tables` record on first use and kept (Convex exports `tables` when it pushes,
 * so what a table declares until then counts). Its errors are `defineSchema`'s, which checks the tables when it runs.
 */
export function declaredTables(schema: Pick<EngineSchema, "tables">): Map<string, DeclaredTable> {
  let out = declared.get(schema);
  if (!out) {
    out = declareTables(schema.tables);
    declared.set(schema, out);
  }
  return out;
}

/** The engine's declaration of each table, with Convex's push-time checks of names and indexes. */
function declareTables(tables: GenericSchema): Map<string, DeclaredTable> {
  if (tables === null || typeof tables !== "object" || tables instanceof Map)
    throw new Error("A schema's tables must be an object of table definitions (defineTable(...)).");
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
      indexes: { ...t.indexFields },
      document: t.document,
      staged: [...t.stagedIndexes],
      ...(Object.keys(t.searchIndexDefs).length
        ? { searchIndexes: structuredClone(t.searchIndexDefs), stagedSearch: [...t.stagedSearch] }
        : {}),
      ...(Object.keys(t.vectorIndexDefs).length
        ? { vectorIndexes: structuredClone(t.vectorIndexDefs), stagedVector: [...t.stagedVector] }
        : {}),
      ...(t.stagedDocument === undefined ? {} : { stagedDocument: t.stagedDocument }),
    });
  }
  for (const t of Object.values(tables)) checkIndexSystemFields(t);
  return out;
}

/**
 * The schema's tables in the order a push creates the new ones, as Convex's start of a push: its added indexes first,
 * in index-name order (`prepare_new_and_mutated_indexes`), each creating its table if missing, so the tables with any
 * index (database, staged, text or vector) by name; then `submit_pending` the rest, by name (`BTreeMap` order, which on
 * ASCII identifiers is JavaScript's string order). New tables take their numbers in this order (STUDY-161 §7).
 */
export function pushOrder(tables: Iterable<DeclaredTable>): DeclaredTable[] {
  const indexed = (t: DeclaredTable) =>
    Object.keys(t.indexes).length +
      Object.keys(t.searchIndexes ?? {}).length +
      Object.keys(t.vectorIndexes ?? {}).length >
    0;
  const byName = (a: DeclaredTable, b: DeclaredTable) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const all = [...tables];
  return [...all.filter(indexed).sort(byName), ...all.filter((t) => !indexed(t)).sort(byName)];
}

/** A table definition holding what `table` declares (a schema the engine made, e.g. from a pushed schema's JSON). */
function tableDefinitionOf(table: DeclaredTable): TableDefinition {
  const t = new TableDefinition(table.document);
  const staged = new Set(table.staged ?? []);
  for (const [name, fields] of Object.entries(table.indexes))
    t.index(name, staged.has(name) ? { fields: [...fields], staged: true } : [...fields]);
  const stagedSearch = new Set(table.stagedSearch ?? []);
  for (const [name, d] of Object.entries(structuredClone(table.searchIndexes ?? {})))
    if (stagedSearch.has(name)) t.searchIndex(name, { ...d, staged: true });
    else t.searchIndex(name, d);
  const stagedVector = new Set(table.stagedVector ?? []);
  for (const [name, d] of Object.entries(structuredClone(table.vectorIndexes ?? {})))
    if (stagedVector.has(name)) t.vectorIndex(name, { ...d, staged: true });
    else t.vectorIndex(name, d);
  if (table.stagedDocument !== undefined) t.stagedDocument = table.stagedDocument;
  return t;
}

/**
 * A schema of tables the engine declared (a pushed schema read back, an empty one): its `tables` record made of
 * table definitions holding the same, and `declaredTables` giving `tables` as it is.
 */
export function schemaOfDeclared(tables: Map<string, DeclaredTable>, schemaValidation: boolean): EngineSchema {
  const schema: EngineSchema = {
    tables: Object.fromEntries([...tables].map(([name, t]) => [name, tableDefinitionOf(t)])),
    strictTableNameTypes: undefined,
    schemaValidation,
  };
  declared.set(schema, tables);
  return schema;
}

/**
 * Convex's `defineSchema`. With `schemaValidation` (the default), every document written to a declared
 * table must match its validator (with `_id` and `_creationTime` added); tables not declared accept anything.
 * `tables` is kept as given (Convex's `schema.tables`); the checks Convex makes at push run here.
 */
export function defineSchema<Schema extends GenericSchema, StrictTableNameTypes extends boolean = true>(
  tables: Schema,
  options: DefineSchemaOptions<StrictTableNameTypes> = {},
): SchemaDefinition<Schema, StrictTableNameTypes> {
  // Convex's push-time checks, run here as before; the tables are declared from the record when first read (a push,
  // the engine), as Convex exports `tables` when it pushes: an index added to a table after `defineSchema` counts.
  declareTables(tables);
  // Convex's `tableInSchema`: the definition of a table of this schema, or its error.
  const tableOf = (name: string) => {
    const t = Object.hasOwn(tables, name) ? tables[name] : undefined;
    if (t === undefined)
      throw new Error(
        `Table "${name}" is not in this schema. Tables in this schema: ${Object.keys(tables).join(", ")}`,
      );
    return t;
  };
  const helpers: SchemaValidators<Schema> = {
    doc: (name) => docValidator(name, tableOf(name)) as never,
    id: (name) => {
      tableOf(name);
      return v.id(name);
    },
  };
  // As Convex's class: `tables`, `strictTableNameTypes` (never set) and `schemaValidation` are the instance's own
  // fields, in its order; `doc` and `id` are not enumerable.
  return Object.defineProperties(
    { tables, strictTableNameTypes: undefined, schemaValidation: options.schemaValidation ?? true },
    { doc: { value: helpers.doc }, id: { value: helpers.id } },
  ) as unknown as SchemaDefinition<Schema, StrictTableNameTypes>;
}

/**
 * A table's validator for its stored documents: the declared one, or null for `v.any()`. It never names the system
 * fields: `checkDocument` leaves them out of the document, as Convex's `DocumentSchema::check_value`.
 */
export function documentValidator(_table: string, doc: GenericValidator): GenericValidator | null {
  return doc.kind === "any" ? null : doc;
}

/**
 * A stored document against its table's validator (`documentValidator`), as Convex's `DocumentSchema::check_value`:
 * every top-level field that starts with `_` left out (`filter_system_fields`), so the error's display shows neither
 * `_id` nor `_creationTime`. The violation's message, or null.
 */
export function checkDocument(
  validator: GenericValidator,
  doc: Record<string, unknown>,
  tableOf: (n: number) => string | undefined,
): string | null {
  const fields: Record<string, unknown> = {};
  for (const k of Object.keys(doc)) if (!k.startsWith("_")) fields[k] = doc[k];
  return checkValue(validator, fields as Value, tableOf);
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

/** Convex's reserved index descriptors (`by_id`, `by_creation_time`, `_…`): their I/O is not metered. */
export const isReservedIndex = (ix: IndexDef) =>
  ix.name === "by_id" || ix.name === "by_creation_time" || ix.name.startsWith("_");

/**
 * An index entry's metered size, as Convex's `IndexKey::size` (STUDY-71): the document id's 33 bytes (table
 * number and internal id) plus the size of each indexed value present, the `_id` string included.
 */
export function indexKeySize(ix: IndexDef, doc: Doc): number {
  let n = 33;
  for (const v of indexKeyValues(ix, doc)) if (v !== undefined) n += rawValueSize(v);
  return n;
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

/**
 * Convex's check when a table definition is exported (`TableDefinition.export`): the document validator's JSON
 * must be an object. `schemaToJson`, bunvex's `export`, runs it; a push answers it as Convex does
 * (`InvalidSchemaExport`). Convex's message ends with a docs link, left out (DV-397).
 */
export function documentJson(document: GenericValidator): ValidatorJSON {
  const json: unknown = document.json;
  if (typeof json !== "object")
    throw new Error("Invalid validator: please make sure that the parameter of `defineTable` is valid");
  return json as ValidatorJSON;
}

/**
 * Convex's parse of a pushed schema's `documentType` (`DocumentSchema::try_from`, crates/common/src/schemas/
 * json.rs): an object, a union of objects, or `v.any()`. The first table's failure, naming the validator (for a
 * union, its first member that is not an object), or null. Convex's message ends with a docs link, left out
 * (DV-397).
 */
export function documentTypeError(schema: EngineSchema): string | null {
  for (const t of declaredTables(schema).values()) {
    const d = t.document;
    if (d.kind === "object" || d.kind === "any") continue;
    const bad = d.kind === "union" ? (d.members as GenericValidator[]).find((m) => m.kind !== "object") : d;
    if (bad)
      return `The document validator in a schema must be an object, a union of objects, or \`v.any()\`. Found ${displayValidator(bad)}.`;
  }
  return null;
}

/**
 * Convex's `check_index_references` (crates/common/src/schemas/mod.rs), run when a push evaluates its schema:
 * with `schemaValidation`, every field an index names must be one the table's validator can hold, and a
 * vector index's field one that can hold an array of float64. Tables in name order; in each, the database
 * indexes' fields (then the staged ones'), the search fields, the search filter fields and the vector fields,
 * then the vector fields' types. The first failure's message, or null.
 */
export function indexReferenceError(schema: EngineSchema): string | null {
  if (!schema.schemaValidation) return null;
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  for (const [table, t] of [...declaredTables(schema)].sort(([a], [b]) => byName(a, b))) {
    const doc = t.document.json;
    const staged = new Set(t.staged ?? []);
    const stagedSearch = new Set(t.stagedSearch ?? []);
    const stagedVector = new Set(t.stagedVector ?? []);
    // Each kind's live indexes in name order, then its staged ones (Convex keeps them in two maps).
    const ordered = <T>(m: Record<string, T> | undefined, isStaged: Set<string>) => {
      const all = Object.entries(m ?? {}).sort(([a], [b]) => byName(a, b));
      return [...all.filter(([n]) => !isStaged.has(n)), ...all.filter(([n]) => isStaged.has(n))];
    };
    const search = ordered(t.searchIndexes, stagedSearch);
    const vector = ordered(t.vectorIndexes, stagedVector);
    const referenced: [string, string][] = [
      ...ordered(t.indexes, staged).flatMap(([name, fields]) => fields.map((f) => [name, f] as [string, string])),
      ...search.map(([name, d]) => [name, d.searchField] as [string, string]),
      ...search.flatMap(([name, d]) => d.filterFields.map((f) => [name, f] as [string, string])),
      ...vector.map(([name, d]) => [name, d.vectorField] as [string, string]),
    ];
    for (const [index, field] of referenced) {
      const path = field.split(".");
      // A system field may be named whatever the validator says.
      if ((path.length === 1 && path[0]!.startsWith("_")) || canContainField(doc, path)) continue;
      return `In table "${table}" the index "${index}" is invalid because it references the field "${field}" that does not exist.`;
    }
    for (const [index, d] of vector)
      if (!mayHoldVector(doc, d.vectorField.split(".")))
        return `In table "${table}" the vector index "${index}" is invalid because it references the field "${d.vectorField}" that is neither an array of float64 or optional array of float64.`;
  }
  return null;
}

/** Convex's `Validator::can_contain_field`: whether some value the validator accepts has the field. */
function canContainField(v: ValidatorJSON, path: string[]): boolean {
  if (path.length === 0) return true;
  switch (v.type) {
    case "any":
      return true;
    case "union":
      return v.value.some((c) => canContainField(c, path));
    case "object": {
      const f = Object.hasOwn(v.value, path[0]!) ? v.value[path[0]!] : undefined;
      return f !== undefined && canContainField(f.fieldType, path.slice(1));
    }
    default:
      return false;
  }
}

/**
 * Convex's `Validator::overlaps_with_array_float64`: whether the field may hold an array of float64. A field
 * an object does not declare counts as yes (only a missing field fails, and the existence check runs first).
 */
function mayHoldVector(v: ValidatorJSON, path: string[]): boolean {
  if (path.length === 0) return isVectorValidator(v);
  switch (v.type) {
    case "any":
      return true;
    case "union":
      return v.value.some((c) => mayHoldVector(c, path));
    case "object": {
      const f = Object.hasOwn(v.value, path[0]!) ? v.value[path[0]!] : undefined;
      return f === undefined || mayHoldVector(f.fieldType, path.slice(1));
    }
    default:
      return false;
  }
}

function isVectorValidator(v: ValidatorJSON): boolean {
  if (v.type === "array") return v.value.type === "number" || v.value.type === "any";
  if (v.type === "any") return true;
  if (v.type === "union") return v.value.some(isVectorValidator);
  return false;
}
