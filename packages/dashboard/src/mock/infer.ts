// A document type inferred from documents (STUDY-12 D11, "Generated" schema), as a source would compute it
// over a whole table — Convex keeps "shapes" for this. Every document fits the result: a field missing from
// some is optional, a field of several types is a union, objects merge their fields, an array's elements
// are the union of theirs (no element at all: `v.any()`), and text that is always an id of one table is
// `v.id(table)`. System fields are left out, as a schema writes them.
import type { Document, ObjectFieldJson, ValidatorJson, Value } from "../data-source.ts";
import { valueType } from "../filters.ts";

/** Merges `b` into `a`: the smallest validator (in these terms) both fit. */
function merge(a: ValidatorJson | undefined, b: ValidatorJson): ValidatorJson {
  if (a === undefined) return b;
  if (a.type === "object" && b.type === "object") {
    const value: Record<string, ObjectFieldJson> = {};
    for (const k of new Set([...Object.keys(a.value), ...Object.keys(b.value)])) {
      const x = a.value[k];
      const y = b.value[k];
      value[k] =
        x && y
          ? { fieldType: merge(x.fieldType, y.fieldType), optional: x.optional || y.optional }
          : { fieldType: (x ?? y)!.fieldType, optional: true };
    }
    return { type: "object", value };
  }
  if (a.type === "array" && b.type === "array")
    // an empty array tells nothing about the elements: the other array's elements win
    return {
      type: "array",
      value: a.value === NOTHING ? b.value : b.value === NOTHING ? a.value : merge(a.value, b.value),
    };
  if (a.type === "any" && b.type === "any") return a;
  const members = a.type === "union" ? a.value : [a];
  const same = members.findIndex(
    (m) => m.type === b.type && (m.type !== "id" || JSON.stringify(m) === JSON.stringify(b)),
  );
  if (same >= 0) {
    const next = [...members];
    const m = members[same]!;
    // the same kind: objects and arrays merge what they hold; anything else is already it
    next[same] = m.type === "object" || m.type === "array" ? merge(m, b) : m;
    return next.length === 1 ? next[0]! : { type: "union", value: next };
  }
  return { type: "union", value: [...members, b] };
}

// an array that never held an element: nothing is known of its elements yet
const NOTHING: ValidatorJson = { type: "any" };

function shapeOf(v: Value, tableOf: (id: string) => string | null): ValidatorJson {
  switch (valueType(v)) {
    case "null":
      return { type: "null" };
    case "boolean":
      return { type: "boolean" };
    case "number":
      return { type: "number" };
    case "int64":
      return { type: "bigint" };
    case "bytes":
      return { type: "bytes" };
    case "string": {
      const table = tableOf(v as string);
      return table ? { type: "id", tableName: table } : { type: "string" };
    }
    case "array": {
      let element: ValidatorJson | undefined;
      for (const x of v as Value[]) element = merge(element, shapeOf(x, tableOf));
      return { type: "array", value: element ?? NOTHING };
    }
    default:
      return objectShape(v as Record<string, Value>, tableOf);
  }
}

function objectShape(o: Record<string, Value>, tableOf: (id: string) => string | null): ValidatorJson {
  const value: Record<string, ObjectFieldJson> = {};
  for (const [k, x] of Object.entries(o)) value[k] = { fieldType: shapeOf(x, tableOf), optional: false };
  return { type: "object", value };
}

/** The type every one of `docs` fits, without system fields; null when there are none. */
export function inferDocumentType(docs: Document[], tableOf: (id: string) => string | null): ValidatorJson | null {
  let type: ValidatorJson | undefined;
  for (const d of docs) {
    const own = Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith("_"))) as Record<string, Value>;
    type = merge(type, objectShape(own, tableOf));
  }
  return type ?? null;
}
