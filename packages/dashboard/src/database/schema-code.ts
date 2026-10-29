// The deployment's declared schema as the `bunvex/schema.ts` that declares it (STUDY-12 §8, V2): each
// declared table's document type as `v.*` code and its indexes, as Convex's dashboard shows the saved
// schema. Also says which lines are a given table's, to highlight them.
import type { DeclaredIndexes, SchemaInfo, TableInfo, ValidatorJson } from "../data-source.ts";
import { displayValidator } from "../validators.ts";

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));

/** A table's document type as `defineTable`'s argument: an object's fields as `{ … }`, anything else as is. */
function documentType(v: ValidatorJson | undefined, indent: string): string {
  const shown = displayValidator(v ?? { type: "any" }, { indent });
  return v?.type === "object" && shown.startsWith("v.object(") ? shown.slice("v.object(".length, -1) : shown;
}

const list = (xs: string[]) => `[${xs.map((x) => JSON.stringify(x)).join(", ")}]`;
/** An index's fields as a schema declares them: the system ones (`_creationTime`) left out, as Convex's. */
const own = (fields: string[]) => fields.filter((f) => !f.startsWith("_"));

/**
 * The schema's declared indexes as its code writes them, in Convex's `displayTableDefinition` order: database
 * indexes, staged ones, search indexes, staged ones, vector indexes, staged ones (`{ …, staged: true }`); a search or
 * vector index's `filterFields` only when it has some.
 */
function declaredIndexes(d: DeclaredIndexes): string {
  const staged = (s: boolean) => (s ? ", staged: true" : "");
  const filters = (f: string[]) => (f.length > 0 ? `, filterFields: ${list(f)}` : "");
  const byStaged = <T extends { staged: boolean }>(xs: T[]) => [
    ...xs.filter((x) => !x.staged),
    ...xs.filter((x) => x.staged),
  ];
  return [
    ...byStaged(d.database).map((i) =>
      i.staged
        ? `.index(${JSON.stringify(i.name)}, { fields: ${list(own(i.fields))}, staged: true })`
        : `.index(${JSON.stringify(i.name)}, ${list(own(i.fields))})`,
    ),
    ...byStaged(d.search).map(
      (i) =>
        `.searchIndex(${JSON.stringify(i.name)}, { searchField: ${JSON.stringify(i.searchField)}${filters(i.filterFields)}${staged(i.staged)} })`,
    ),
    ...byStaged(d.vector).map(
      (i) =>
        `.vectorIndex(${JSON.stringify(i.name)}, { vectorField: ${JSON.stringify(i.vectorField)}, dimensions: ${i.dimensions}${filters(i.filterFields)}${staged(i.staged)} })`,
    ),
  ].join("");
}

/**
 * Declared indexes, as `.index("name", ["field", …])`; system fields (`_creationTime`) are implied. From the schema's
 * own lists when the source gives them (every kind, staged ones too), else from the table's database indexes.
 */
function indexes(table: TableInfo | undefined, declared: DeclaredIndexes | undefined): string {
  if (declared) return declaredIndexes(declared);
  return (table?.indexes ?? [])
    .filter((ix) => !ix.system)
    .map(
      (ix) =>
        `.index(${JSON.stringify(ix.name)}, [${ix.fields
          .filter((f) => !f.startsWith("_"))
          .map((f) => JSON.stringify(f))
          .join(", ")}])`,
    )
    .join("");
}

export type SchemaCode = {
  code: string;
  /** Per declared table, its lines in `code` (1-based, inclusive). */
  lines: Map<string, { from: number; to: number }>;
};

/** The schema file, or null when nothing is declared. */
export function schemaCode(schema: SchemaInfo, tables: TableInfo[]): SchemaCode | null {
  if (schema.tables.length === 0) return null;
  // validation is on unless the schema turns it off, as in Convex; with the option, the tables object moves in
  const options = !schema.enforced;
  const indent = options ? "    " : "  ";
  const out = [
    'import { defineSchema, defineTable } from "@bunvex/server";',
    'import { v } from "@bunvex/values";',
    "",
    ...(options ? ["export default defineSchema(", "  {"] : ["export default defineSchema({"]),
  ];
  const lines = new Map<string, { from: number; to: number }>();
  const declared = [...schema.tables].sort((a, b) => a.name.localeCompare(b.name));
  for (const t of declared) {
    const table = tables.find((x) => x.name === t.name);
    const text = `${indent}${key(t.name)}: defineTable(${documentType(t.validator, indent)})${indexes(table, t.indexes)},`;
    const from = out.length + 1;
    out.push(...text.split("\n"));
    lines.set(t.name, { from, to: out.length });
  }
  out.push(...(options ? ["  },", "  { schemaValidation: false },", ");"] : ["});"]));
  return { code: out.join("\n"), lines };
}

/**
 * A schema generated for one table from its documents (the "Generated" tab), as Convex's dashboard writes it:
 * the table alone, with a comment where the deployment's other tables go.
 */
export function generatedSchemaCode(table: string, type: ValidatorJson): string {
  const one = schemaCode({ enforced: true, tables: [{ name: table, validator: type }] }, [])!;
  const lines = one.code.split("\n");
  const at = lines.indexOf("export default defineSchema({") + 1;
  lines.splice(at, 0, "  // Other tables here...", "");
  return lines.join("\n");
}
