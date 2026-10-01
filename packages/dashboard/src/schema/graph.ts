// The Schema screen's model (STUDY-12 §14, UI-01 §21): the deployment's tables as nodes with their fields, and an
// edge wherever a field holds a `v.id("table")` — directly or nested in an array, record, object or union — as
// Convex's schema view builds it (`features/schema/lib/buildSchemaGraph.ts`). The declared schema wins; a table
// that holds documents without being declared joins it, flagged and typed from its documents when the source can
// infer that; with no declared schema at all, every table is typed from its documents.
import type { IndexInfo, SchemaInfo, TableInfo, ValidatorJson } from "../data-source.ts";
import { decodeInt64 } from "../filters.ts";

export type SchemaField = {
  name: string;
  /** A compact TypeScript-style label: `string`, `Id<"users">`, `Id<"tags">[]`, `{ … }`. */
  type: string;
  /** The label with every object spelled out, when the compact one hides detail. */
  fullType?: string;
  optional: boolean;
  /** The tables this field points at. */
  references: string[];
};

export type SchemaUnion = {
  /** A field whose literal value picks the member (`kind: "a" | "b"`), when there is one. */
  discriminator?: string;
  variants: { label: string; fields: SchemaField[] }[];
};

export type SchemaNode = {
  table: string;
  /** For a union document type, every member's fields merged (types joined, optional where some lack it). */
  fields: SchemaField[];
  union?: SchemaUnion;
  indexes: IndexInfo[];
  documentCount?: number;
  /** Holds documents but is not declared in the schema. */
  notInSchema: boolean;
  /** Declared (or inferred) without a document type: any fields. */
  untyped: boolean;
};

export type SchemaEdge = { id: string; source: string; target: string; field: string; optional: boolean };

export type SchemaGraph = { nodes: SchemaNode[]; edges: SchemaEdge[] };

// ------------------------------------------------------------------ labels

const literalLabel = (value: unknown): string =>
  typeof value === "object" && value !== null && "$integer" in value
    ? `${decodeInt64(value as { $integer: string })}n`
    : JSON.stringify(value);

const KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A validator as a TypeScript-style type; objects collapse to `{ … }` unless `expand`. */
export function typeLabel(v: ValidatorJson, expand = false): string {
  switch (v.type) {
    case "null":
    case "number":
    case "bigint":
    case "boolean":
    case "string":
    case "any":
      return v.type;
    case "bytes":
      return "ArrayBuffer";
    case "literal":
      return literalLabel(v.value);
    case "id":
      return `Id<"${v.tableName}">`;
    case "array": {
      const inner = typeLabel(v.value, expand);
      return v.value.type === "union" ? `(${inner})[]` : `${inner}[]`;
    }
    case "record":
      return `Record<${typeLabel(v.keys, expand)}, ${typeLabel(v.values.fieldType, expand)}>`;
    case "object": {
      const entries = Object.entries(v.value);
      if (entries.length === 0) return "{}";
      if (!expand) return "{ … }";
      const body = entries
        .map(
          ([k, f]) => `${KEY.test(k) ? k : JSON.stringify(k)}${f.optional ? "?" : ""}: ${typeLabel(f.fieldType, true)}`,
        )
        .join("; ");
      return `{ ${body} }`;
    }
    case "union":
      return v.value.map((m) => typeLabel(m, expand)).join(" | ");
  }
}

/** Every table a validator points at, in order of appearance. */
export function referencesOf(v: ValidatorJson, into: string[] = []): string[] {
  switch (v.type) {
    case "id":
      if (!into.includes(v.tableName)) into.push(v.tableName);
      break;
    case "array":
      referencesOf(v.value, into);
      break;
    case "record":
      referencesOf(v.values.fieldType, into);
      break;
    case "object":
      for (const f of Object.values(v.value)) referencesOf(f.fieldType, into);
      break;
    case "union":
      for (const m of v.value) referencesOf(m, into);
      break;
  }
  return into;
}

function field(name: string, type: ValidatorJson, optional: boolean): SchemaField {
  const compact = typeLabel(type);
  const full = typeLabel(type, true);
  return { name, type: compact, ...(full !== compact && { fullType: full }), optional, references: referencesOf(type) };
}

const objectFields = (v: Extract<ValidatorJson, { type: "object" }>): SchemaField[] =>
  Object.entries(v.value).map(([name, f]) => field(name, f.fieldType, f.optional));

// ------------------------------------------------------------------ unions

type ObjectV = Extract<ValidatorJson, { type: "object" }>;

/** A field every member has, as a literal, with a different value in each member. */
function discriminatorOf(members: ObjectV[]): string | undefined {
  const [first] = members;
  if (!first) return undefined;
  for (const name of Object.keys(first.value)) {
    const values = members.map((m) => {
      const f = m.value[name];
      return f && !f.optional && f.fieldType.type === "literal" ? JSON.stringify(f.fieldType.value) : undefined;
    });
    if (values.every((x) => x !== undefined) && new Set(values).size === members.length) return name;
  }
  return undefined;
}

function unionOf(v: ValidatorJson): SchemaUnion | undefined {
  if (v.type !== "union" || v.value.length < 2 || !v.value.every((m) => m.type === "object")) return undefined;
  const members = v.value as ObjectV[];
  const discriminator = discriminatorOf(members);
  return {
    ...(discriminator && { discriminator }),
    variants: members.map((m, i) => {
      const fields = objectFields(m);
      const d = discriminator ? fields.find((f) => f.name === discriminator) : undefined;
      // the discriminator first, so each variant reads as "kind: …, then its own fields"
      return {
        label: d ? d.type : `Variant ${i + 1}`,
        fields: d ? [d, ...fields.filter((f) => f !== d)] : fields,
      };
    }),
  };
}

/** One field list for a union: a field's types joined; optional when some member lacks it or has it optional. */
function mergeVariants(variants: SchemaField[][]): SchemaField[] {
  const order: string[] = [];
  const byName = new Map<string, SchemaField[]>();
  for (const fields of variants)
    for (const f of fields) {
      if (!byName.has(f.name)) {
        byName.set(f.name, []);
        order.push(f.name);
      }
      byName.get(f.name)!.push(f);
    }
  return order.map((name) => {
    const all = byName.get(name)!;
    const types = [...new Set(all.map((f) => f.type))];
    const fulls = [...new Set(all.map((f) => f.fullType ?? f.type))];
    const type = types.join(" | ");
    const full = fulls.join(" | ");
    return {
      name,
      type,
      ...(full !== type && { fullType: full }),
      optional: all.length < variants.length || all.some((f) => f.optional),
      references: [...new Set(all.flatMap((f) => f.references))],
    };
  });
}

/** A table's fields from its document type: an object's fields, a union's merged, anything else none. */
function fieldsOf(v: ValidatorJson | undefined | null): {
  fields: SchemaField[];
  union?: SchemaUnion;
  untyped: boolean;
} {
  if (!v || v.type === "any") return { fields: [], untyped: true };
  if (v.type === "object") return { fields: objectFields(v), untyped: false };
  const union = unionOf(v);
  if (union) return { fields: mergeVariants(union.variants.map((x) => x.fields)), union, untyped: false };
  return { fields: [], untyped: true };
}

// ------------------------------------------------------------------ the graph

/**
 * The graph for a deployment: `null` when there is nothing to draw (no declared table and no table at all).
 * `inferred` holds the document types the source inferred for tables without a declared one (`null`: it could
 * not), keyed by table.
 */
export function buildSchemaGraph(
  schema: SchemaInfo,
  tables: TableInfo[],
  inferred: Record<string, ValidatorJson | null | undefined> = {},
): SchemaGraph | null {
  const info = new Map(tables.map((t) => [t.name, t]));
  const declared = new Map(schema.tables.map((t) => [t.name, t]));
  const names = [...new Set([...schema.tables.map((t) => t.name), ...tables.map((t) => t.name)])].sort();
  if (names.length === 0) return null;
  const hasSchema = schema.tables.length > 0;

  const nodes: SchemaNode[] = names.map((table) => {
    const decl = declared.get(table);
    const t = info.get(table);
    const typed = fieldsOf(decl ? decl.validator : inferred[table]);
    return {
      table,
      ...typed,
      indexes: t?.indexes ?? [],
      ...(t?.documentCount !== undefined && { documentCount: t.documentCount }),
      notInSchema: hasSchema && !decl,
    };
  });

  const present = new Set(names);
  const edges: SchemaEdge[] = [];
  for (const n of nodes)
    for (const f of n.fields)
      for (const target of f.references)
        if (present.has(target))
          edges.push({
            id: `${n.table}.${f.name}->${target}`,
            source: n.table,
            target,
            field: f.name,
            optional: f.optional,
          });
  return { nodes, edges };
}
