// A schema as JSON (STUDY-35), in the shape of Convex's `DatabaseSchema` export: what a push stores in
// `_schemas`, so a deployable server restarts on the schema it was last pushed, and what the push reports.
import { type GenericValidator, type ValidatorJSON, validatorFromJson } from "@bunvex/values";
import type { DeclaredTable, SchemaDefinition } from "./schema.ts";

export type IndexJson = { indexDescriptor: string; fields: string[] };
/** A search index, as Convex's schema JSON (`filterFields` sorted, as Convex serializes its set). */
export type SearchIndexJson = { indexDescriptor: string; searchField: string; filterFields: string[] };
export type TableJson = {
  tableName: string;
  indexes: IndexJson[];
  stagedDbIndexes: IndexJson[];
  /** Optional, as in Convex's schema JSON. */
  searchIndexes?: SearchIndexJson[];
  stagedSearchIndexes?: SearchIndexJson[];
  documentType: ValidatorJSON | null;
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
        documentType: anyJson(t.document),
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
    });
  }
  return { tables, schemaValidation: j.schemaValidation };
}
