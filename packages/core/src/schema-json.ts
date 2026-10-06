// A schema as JSON (STUDY-35), as Convex stores it in `_schemas` (STUDY-134): its `DatabaseSchemaJson`
// (crates/common/src/schemas/json.rs), the pushed schema parsed and serialized again. What a push stores, so a
// deployable server restarts on the schema it was last pushed, and what the push reports.
//
// Convex's parse fixes the form: tables by name, each kind of index by name (its `BTreeMap`s), every list
// present (empty when none), `stagedDocumentType` null when none, an index's fields with the `_creationTime`
// Convex appends (application/src/lib.rs `_validate_user_defined_index_fields`), filter fields as a sorted set,
// a vector index's legacy `dimension: null`, an object validator's fields by name and a table's top-level system
// fields left out (`filter_system_fields`). The text is serde_json's, whose only difference from
// `JSON.stringify` here is a float literal's form (`1.0`, `1e16`).
import { type GenericValidator, type ValidatorJSON, validatorFromJson } from "@bunvex/values";
import {
  type DeclaredTable,
  type SchemaDefinition,
  stagedDocumentJson,
  documentJson as validDocumentJson,
} from "./schema.ts";

export type IndexJson = { indexDescriptor: string; fields: string[] };
/** A search index, as Convex's schema JSON (`filterFields` sorted, as Convex serializes its set). */
export type SearchIndexJson = { indexDescriptor: string; searchField: string; filterFields: string[] };
/** A vector index, as Convex's schema JSON (`filterFields` sorted; `dimension`, a legacy name, always null). */
export type VectorIndexJson = {
  indexDescriptor: string;
  vectorField: string;
  dimensions: number;
  dimension?: null;
  filterFields: string[];
};
export type TableJson = {
  tableName: string;
  indexes: IndexJson[];
  stagedDbIndexes: IndexJson[];
  searchIndexes: SearchIndexJson[];
  stagedSearchIndexes: SearchIndexJson[];
  vectorIndexes: VectorIndexJson[];
  stagedVectorIndexes: VectorIndexJson[];
  /** Null only in a schema read back that had none (Convex's `Option`). */
  documentType: ValidatorJSON | null;
  /** `.staged()`'s validator (STUDY-106); null without one. */
  stagedDocumentType: ValidatorJSON | null;
};
export type SchemaJson = { tables: TableJson[]; schemaValidation: boolean };

/**
 * A `_schemas` row's `state`, as Convex's `SerializedSchemaState` (crates/common/src/bootstrap_model/
 * schema_state.rs): an object tagged by `state`; a failed schema's error and table in it (`table_name`, as
 * Convex's serde leaves that field's name).
 */
export type SchemaStateJson =
  | { state: "pending" | "validated" | "active" | "overwritten" }
  | { state: "failed"; error: string; table_name: string | null };

/** A `_schemas` row's state name (undefined: no row). */
export const schemaStateOf = (row: Record<string, unknown> | null | undefined): SchemaStateJson["state"] | undefined =>
  (row?.state as SchemaStateJson | undefined)?.state;

/** A failed `_schemas` row's error and table, or null when it has not failed. */
export function schemaFailureOf(
  row: Record<string, unknown> | null | undefined,
): { error: string; tableName: string | null } | null {
  const s = row?.state as SchemaStateJson | undefined;
  return s?.state === "failed" ? { error: s.error, tableName: s.table_name ?? null } : null;
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const CREATION_TIME = "_creationTime";

/** A validator's JSON as Convex parses and serializes it again: only its own fields, an object's by name. */
function canonical(j: ValidatorJSON): ValidatorJSON {
  switch (j.type) {
    case "id":
      return { type: "id", tableName: j.tableName };
    case "literal":
      return { type: "literal", value: j.value };
    case "array":
      return { type: "array", value: canonical(j.value) };
    case "object":
      return {
        type: "object",
        value: Object.fromEntries(
          Object.keys(j.value)
            .sort(byName)
            .map((k) => [k, { fieldType: canonical(j.value[k]!.fieldType), optional: j.value[k]!.optional }]),
        ),
      };
    case "record":
      return {
        type: "record",
        keys: canonical(j.keys),
        values: { fieldType: canonical(j.values.fieldType), optional: false },
      };
    case "union":
      return { type: "union", value: j.value.map(canonical) };
    default:
      return { type: j.type };
  }
}

/** A table's document validator as Convex's `DocumentSchema` serializes it: system fields out, a one-object union an object. */
function documentType(j: ValidatorJSON): ValidatorJSON {
  const c = canonical(j);
  const withoutSystem = (o: ValidatorJSON): ValidatorJSON =>
    o.type === "object"
      ? { type: "object", value: Object.fromEntries(Object.entries(o.value).filter(([k]) => !k.startsWith("_"))) }
      : o;
  if (c.type === "object") return withoutSystem(c);
  if (c.type === "union") {
    const members = c.value.map(withoutSystem);
    return members.length === 1 ? members[0]! : { type: "union", value: members };
  }
  return c;
}

// The validator checked first (`documentJson`: Convex's export error for one that is not an object).
const documentJson = (v: GenericValidator) => documentType(validDocumentJson(v));

/** The schema as Convex's `DatabaseSchemaJson`. Throws Convex's export error for a staged validator that is not an object. */
export function schemaToJson(s: SchemaDefinition): SchemaJson {
  const tables = [...s.tables.values()].sort((a, b) => byName(a.name, b.name));
  return {
    tables: tables.map((t) => {
      const staged = new Set(t.staged ?? []);
      const names = Object.keys(t.indexes).sort(byName);
      const index = (name: string): IndexJson => ({
        indexDescriptor: name,
        fields: [...t.indexes[name]!, CREATION_TIME],
      });
      const stagedDocument = t.stagedDocument === undefined ? null : documentType(stagedDocumentJson(t.stagedDocument));
      return {
        tableName: t.name,
        indexes: names.filter((n) => !staged.has(n)).map(index),
        stagedDbIndexes: names.filter((n) => staged.has(n)).map(index),
        ...searchJson(t),
        ...vectorJson(t),
        documentType: documentJson(t.document),
        stagedDocumentType: stagedDocument,
      };
    }),
    schemaValidation: s.schemaValidation,
  };
}

function searchJson(t: DeclaredTable): Pick<TableJson, "searchIndexes" | "stagedSearchIndexes"> {
  const all = t.searchIndexes ?? {};
  const staged = new Set(t.stagedSearch ?? []);
  const names = Object.keys(all).sort(byName);
  const one = (name: string): SearchIndexJson => ({
    indexDescriptor: name,
    searchField: all[name]!.searchField,
    filterFields: [...new Set(all[name]!.filterFields)].sort(byName),
  });
  return {
    searchIndexes: names.filter((n) => !staged.has(n)).map(one),
    stagedSearchIndexes: names.filter((n) => staged.has(n)).map(one),
  };
}

function vectorJson(t: DeclaredTable): Pick<TableJson, "vectorIndexes" | "stagedVectorIndexes"> {
  const all = t.vectorIndexes ?? {};
  const staged = new Set(t.stagedVector ?? []);
  const names = Object.keys(all).sort(byName);
  const one = (name: string): VectorIndexJson => ({
    indexDescriptor: name,
    vectorField: all[name]!.vectorField,
    dimensions: all[name]!.dimensions,
    dimension: null,
    filterFields: [...new Set(all[name]!.filterFields)].sort(byName),
  });
  return {
    vectorIndexes: names.filter((n) => !staged.has(n)).map(one),
    stagedVectorIndexes: names.filter((n) => staged.has(n)).map(one),
  };
}

/**
 * A float as serde_json writes it (ryu): decimal with a `.0` when whole for exponents −5 to 15, else
 * scientific (`1e16`, `1.5e-7`).
 */
function f64Text(n: number): string {
  if (n === 0) return Object.is(n, -0) ? "-0.0" : "0.0";
  const exp = Number(n.toExponential().split("e")[1]);
  if (exp >= -5 && exp <= 15) {
    const s = String(n);
    return s.includes(".") ? s : `${s}.0`;
  }
  return n.toExponential().replace("e+", "e");
}

function text(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string" || typeof v === "boolean" || typeof v === "number") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(text).join(",")}]`;
  const o = v as Record<string, unknown>;
  // A float literal: the one float a schema holds.
  if (o.type === "literal" && typeof o.value === "number") return `{"type":"literal","value":${f64Text(o.value)}}`;
  return `{${Object.entries(o)
    .filter(([, x]) => x !== undefined)
    .map(([k, x]) => `${JSON.stringify(k)}:${text(x)}`)
    .join(",")}}`;
}

/** The schema's text as `_schemas` stores it (and the audit log's `schemaDiff` shows it): Convex's, byte for byte. */
export const schemaJsonText = (s: SchemaDefinition): string => text(schemaToJson(s));

export function schemaFromJson(j: SchemaJson): SchemaDefinition {
  const tables = new Map<string, DeclaredTable>();
  // The `_creationTime` Convex appends to an index is bunvex's implicit one (catalog.ts `wantedIndexes`).
  const userFields = (fields: string[]) =>
    fields.length && fields[fields.length - 1] === CREATION_TIME ? fields.slice(0, -1) : [...fields];
  for (const t of j.tables) {
    const indexes: Record<string, string[]> = {};
    for (const i of [...t.indexes, ...(t.stagedDbIndexes ?? [])]) indexes[i.indexDescriptor] = userFields(i.fields);
    tables.set(t.tableName, {
      name: t.tableName,
      indexes,
      document: t.documentType === null ? validatorFromJson({ type: "any" }) : validatorFromJson(t.documentType),
      staged: (t.stagedDbIndexes ?? []).map((i) => i.indexDescriptor),
      ...(t.searchIndexes?.length || t.stagedSearchIndexes?.length
        ? {
            searchIndexes: Object.fromEntries(
              [...(t.searchIndexes ?? []), ...(t.stagedSearchIndexes ?? [])].map((i) => [
                i.indexDescriptor,
                { searchField: i.searchField, filterFields: [...i.filterFields] },
              ]),
            ),
            stagedSearch: (t.stagedSearchIndexes ?? []).map((i) => i.indexDescriptor),
          }
        : {}),
      ...(t.vectorIndexes?.length || t.stagedVectorIndexes?.length
        ? {
            vectorIndexes: Object.fromEntries(
              [...(t.vectorIndexes ?? []), ...(t.stagedVectorIndexes ?? [])].map((i) => [
                i.indexDescriptor,
                { vectorField: i.vectorField, dimensions: i.dimensions, filterFields: [...i.filterFields] },
              ]),
            ),
            stagedVector: (t.stagedVectorIndexes ?? []).map((i) => i.indexDescriptor),
          }
        : {}),
      ...(t.stagedDocumentType == null ? {} : { stagedDocument: validatorFromJson(t.stagedDocumentType) }),
    });
  }
  return { tables, schemaValidation: j.schemaValidation };
}

/**
 * What Convex's `DatabaseSchema` equality compares (crates/common/src/schemas/mod.rs, `PartialEq`), as a string:
 * tables and each kind of index keyed by name (its `BTreeMap`s), an object's fields by name, absent index lists
 * as empty. Array order that Convex keeps (an index's fields, a union's members) is kept.
 */
export function schemaKey(j: SchemaJson): string {
  const byName = <T>(list: T[] | undefined, name: (x: T) => string) =>
    [...(list ?? [])].sort((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0));
  const sorted = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(sorted)
      : x !== null && typeof x === "object"
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, sorted((x as Record<string, unknown>)[k])]),
          )
        : x;
  const index = (i: { indexDescriptor: string }) => i.indexDescriptor;
  return JSON.stringify(
    sorted({
      schemaValidation: j.schemaValidation,
      tables: byName(j.tables, (t) => t.tableName).map((t) => ({
        ...t,
        indexes: byName(t.indexes, index),
        stagedDbIndexes: byName(t.stagedDbIndexes, index),
        searchIndexes: byName(t.searchIndexes, index),
        stagedSearchIndexes: byName(t.stagedSearchIndexes, index),
        vectorIndexes: byName(t.vectorIndexes, index),
        stagedVectorIndexes: byName(t.stagedVectorIndexes, index),
      })),
    }),
  );
}
