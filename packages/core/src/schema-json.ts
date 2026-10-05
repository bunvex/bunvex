// A schema as JSON (STUDY-35), in the shape of Convex's `DatabaseSchema` export: what a push stores in
// `_schemas`, so a deployable server restarts on the schema it was last pushed, and what the push reports.
import { type GenericValidator, type ValidatorJSON, validatorFromJson } from "@bunvex/values";
import type { DeclaredTable, SchemaDefinition } from "./schema.ts";

export type IndexJson = { indexDescriptor: string; fields: string[] };
/** A search index, as Convex's schema JSON (`filterFields` sorted, as Convex serializes its set). */
export type SearchIndexJson = { indexDescriptor: string; searchField: string; filterFields: string[] };
/** A vector index, as Convex's schema JSON (`filterFields` sorted). */
export type VectorIndexJson = {
  indexDescriptor: string;
  vectorField: string;
  dimensions: number;
  filterFields: string[];
};
export type TableJson = {
  tableName: string;
  indexes: IndexJson[];
  stagedDbIndexes: IndexJson[];
  /** Optional, as in Convex's schema JSON. */
  searchIndexes?: SearchIndexJson[];
  stagedSearchIndexes?: SearchIndexJson[];
  vectorIndexes?: VectorIndexJson[];
  stagedVectorIndexes?: VectorIndexJson[];
  documentType: ValidatorJSON | null;
  /** `.staged()`'s validator (STUDY-106); absent without one, as Convex's export leaves it out. */
  stagedDocumentType?: ValidatorJSON;
};
export type SchemaJson = { tables: TableJson[]; schemaValidation: boolean };

const anyJson = (v: GenericValidator) => (v.kind === "any" ? null : v.json);

export function schemaToJson(s: SchemaDefinition): SchemaJson {
  return {
    tables: [...s.tables.values()].map((t) => {
      const staged = new Set(t.staged ?? []);
      const index = (name: string): IndexJson => ({ indexDescriptor: name, fields: [...t.indexes[name]!] });
      return {
        tableName: t.name,
        indexes: Object.keys(t.indexes)
          .filter((n) => !staged.has(n))
          .map(index),
        stagedDbIndexes: Object.keys(t.indexes)
          .filter((n) => staged.has(n))
          .map(index),
        ...searchJson(t),
        ...vectorJson(t),
        documentType: anyJson(t.document),
        ...(t.stagedDocument === undefined ? {} : { stagedDocumentType: t.stagedDocument.json }),
      };
    }),
    schemaValidation: s.schemaValidation,
  };
}

function searchJson(t: DeclaredTable): Pick<TableJson, "searchIndexes" | "stagedSearchIndexes"> {
  const all = t.searchIndexes ?? {};
  if (!Object.keys(all).length) return {};
  const staged = new Set(t.stagedSearch ?? []);
  const one = (name: string): SearchIndexJson => ({
    indexDescriptor: name,
    searchField: all[name]!.searchField,
    filterFields: [...all[name]!.filterFields].sort(),
  });
  return {
    searchIndexes: Object.keys(all)
      .filter((n) => !staged.has(n))
      .map(one),
    stagedSearchIndexes: Object.keys(all)
      .filter((n) => staged.has(n))
      .map(one),
  };
}

function vectorJson(t: DeclaredTable): Pick<TableJson, "vectorIndexes" | "stagedVectorIndexes"> {
  const all = t.vectorIndexes ?? {};
  if (!Object.keys(all).length) return {};
  const staged = new Set(t.stagedVector ?? []);
  const one = (name: string): VectorIndexJson => ({
    indexDescriptor: name,
    vectorField: all[name]!.vectorField,
    dimensions: all[name]!.dimensions,
    filterFields: [...all[name]!.filterFields].sort(),
  });
  return {
    vectorIndexes: Object.keys(all)
      .filter((n) => !staged.has(n))
      .map(one),
    stagedVectorIndexes: Object.keys(all)
      .filter((n) => staged.has(n))
      .map(one),
  };
}

export function schemaFromJson(j: SchemaJson): SchemaDefinition {
  const tables = new Map<string, DeclaredTable>();
  for (const t of j.tables) {
    const indexes: Record<string, string[]> = {};
    for (const i of [...t.indexes, ...t.stagedDbIndexes]) indexes[i.indexDescriptor] = [...i.fields];
    tables.set(t.tableName, {
      name: t.tableName,
      indexes,
      document: t.documentType === null ? validatorFromJson({ type: "any" }) : validatorFromJson(t.documentType),
      staged: t.stagedDbIndexes.map((i) => i.indexDescriptor),
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
