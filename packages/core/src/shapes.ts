// Table shape inference (STUDY-52), as Convex's `shape_inference` crate: the shape of a table's documents,
// a counted lattice — each shape counts the values it describes — built by adding documents one at a time.
// Unions hold 2 to 16 pairwise disjoint variants; when a value would overlap one or make a union too long,
// variants are contracted to a common supertype, in Convex's order (arrays, records, ids, field names,
// strings, floats, objects, then records, then `Unknown`). The dashboard sees a reduced form (`reduceShape`).
import { idTableNumber, type Value } from "@bunvex/values";

/** Convex's ProdConfig limits. */
export const MAX_OBJECT_FIELDS = 64;
export const MAX_UNION_LENGTH = 16;

export type Variant =
  | { kind: "Never" | "Null" | "Int64" | "Boolean" | "FieldName" | "String" | "Bytes" | "Unknown" }
  | { kind: "NegativeInf" | "PositiveInf" | "NegativeZero" | "NaN" | "NormalFloat64" | "Float64" }
  | { kind: "StringLiteral"; literal: string }
  | { kind: "Id"; table: number }
  | { kind: "Array"; element: Shape }
  | { kind: "Object"; fields: Map<string, { shape: Shape; optional: boolean }> }
  | { kind: "Record"; key: Shape; value: Shape }
  | { kind: "Union"; variants: Shape[] };

/** A shape and how many values it describes (Convex's `CountedShape`). */
export type Shape = { n: number; v: Variant };

/** `ShapeEnum`'s variant order, which orders a union's variants. */
const RANK = [
  "Never",
  "Null",
  "Int64",
  "NegativeInf",
  "PositiveInf",
  "NegativeZero",
  "NaN",
  "NormalFloat64",
  "Float64",
  "Boolean",
  "StringLiteral",
  "Id",
  "FieldName",
  "String",
  "Bytes",
  "Array",
  "Object",
  "Record",
  "Union",
  "Unknown",
];
const FLOATS = new Set(["NegativeInf", "PositiveInf", "NegativeZero", "NaN", "NormalFloat64", "Float64"]);
const STRINGISH = new Set(["StringLiteral", "Id", "FieldName", "String"]);
const isFloat = (s: Shape) => FLOATS.has(s.v.kind);
const isStringish = (s: Shape) => STRINGISH.has(s.v.kind);

export const NEVER: Shape = { n: 0, v: { kind: "Never" } };

/** Convex's `is_valid_identifier`: ASCII, a letter or `_` first, letters, digits, `_`, ≤ 64, not all `_`. */
export const isIdentifier = (s: string) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(s) && !/^_+$/.test(s);
/** Convex's `is_valid_field_name`: no leading `$`, ≤ 1024 bytes, printable ASCII. */
export const isFieldName = (s: string) => !s.startsWith("$") && s.length <= 1024 && /^[\x20-\x7e]*$/.test(s);

const scalar = (kind: string): Shape => ({ n: 1, v: { kind } as Variant });

/** A string's shape (Convex's `StringLiteralShape::shape_of`): an id, a literal, a field name, a string. */
function stringShape(s: string): Shape {
  // An id is an `Id` at once (Convex makes it a literal first and promotes literals of one table to `Id`
  // when contracting; the dashboard's form is the same, and this saves decoding it at every merge).
  const table = idTableNumber(s);
  if (table !== null) return { n: 1, v: { kind: "Id", table } };
  if (isIdentifier(s)) return { n: 1, v: { kind: "StringLiteral", literal: s } };
  return scalar(isFieldName(s) ? "FieldName" : "String");
}

function floatShape(x: number): Shape {
  if (Number.isNaN(x)) return scalar("NaN");
  if (x === Number.POSITIVE_INFINITY) return scalar("PositiveInf");
  if (x === Number.NEGATIVE_INFINITY) return scalar("NegativeInf");
  if (Object.is(x, -0)) return scalar("NegativeZero");
  return scalar("NormalFloat64");
}

/** A value's shape (Convex's `Shape::shape_of`). */
export function shapeOf(value: Value): Shape {
  if (value === null) return scalar("Null");
  if (typeof value === "bigint") return scalar("Int64");
  if (typeof value === "number") return floatShape(value);
  if (typeof value === "boolean") return scalar("Boolean");
  if (typeof value === "string") return stringShape(value);
  if (value instanceof ArrayBuffer) return scalar("Bytes");
  if (Array.isArray(value)) {
    const b = new UnionBuilder();
    for (const x of value) b.push(shapeOf(x));
    return { n: 1, v: { kind: "Array", element: b.build() } };
  }
  const entries = Object.entries(value as Record<string, Value>).filter(([, x]) => x !== undefined);
  if (entries.length <= MAX_OBJECT_FIELDS && entries.every(([k]) => isIdentifier(k))) {
    const fields = new Map<string, { shape: Shape; optional: boolean }>();
    for (const [k, x] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      fields.set(k, { shape: shapeOf(x), optional: false });
    return { n: 1, v: { kind: "Object", fields } };
  }
  const keys = new UnionBuilder();
  const values = new UnionBuilder();
  for (const [k, x] of entries) {
    keys.push(stringShape(k));
    values.push(shapeOf(x));
  }
  return { n: 1, v: { kind: "Record", key: keys.build(), value: values.build() } };
}

// ---------------------------------------------------------------- subtyping and overlap

/** Whether every value `a` describes is one `b` describes (Convex's `is_subtype`, counts aside). */
export function isSubtype(a: Shape, b: Shape): boolean {
  const x = a.v;
  const y = b.v;
  if (x.kind === "Never" || y.kind === "Unknown") return true;
  if (x.kind === "Union") return x.variants.every((s) => isSubtype(s, b));
  if (y.kind === "Union") return y.variants.some((s) => isSubtype(a, s));
  switch (y.kind) {
    case "Float64":
      return FLOATS.has(x.kind);
    case "String":
      return STRINGISH.has(x.kind);
    case "FieldName":
      return x.kind === "FieldName" || x.kind === "Id" || (x.kind === "StringLiteral" && isFieldName(x.literal));
    case "Id":
      return (
        (x.kind === "Id" && x.table === y.table) || (x.kind === "StringLiteral" && idTableNumber(x.literal) === y.table)
      );
    case "StringLiteral":
      return x.kind === "StringLiteral" && x.literal === y.literal;
    case "Array":
      return x.kind === "Array" && isSubtype(x.element, y.element);
    case "Record":
      if (x.kind === "Record") return isSubtype(x.key, y.key) && isSubtype(x.value, y.value);
      if (x.kind === "Object")
        return [...x.fields].every(([k, f]) => isSubtype(stringShape(k), y.key) && isSubtype(f.shape, y.value));
      return false;
    case "Object": {
      if (x.kind !== "Object") return false;
      for (const [k, f] of x.fields) {
        const g = y.fields.get(k);
        if (!g || !isSubtype(f.shape, g.shape) || (f.optional && !g.optional)) return false;
      }
      for (const [k, g] of y.fields) if (!g.optional && !x.fields.has(k)) return false;
      return true;
    }
    default:
      return x.kind === y.kind;
  }
}

/** Whether two shapes may describe a common value (Convex's `may_overlap`). */
export function mayOverlap(a: Shape, b: Shape): boolean {
  const x = a.v;
  const y = b.v;
  if (x.kind === "Never" || y.kind === "Never") return false;
  if (x.kind === "Unknown" || y.kind === "Unknown") return true;
  if (isSubtype(a, b) || isSubtype(b, a)) return true;
  if (x.kind === "Array" && y.kind === "Array") return true;
  const objOrRecord = (k: string) => k === "Object" || k === "Record";
  if (objOrRecord(x.kind) && objOrRecord(y.kind)) {
    if (x.kind === "Object" && y.kind === "Object") {
      const missing = (p: typeof x, q: typeof x) => [...p.fields].some(([k, f]) => !f.optional && !q.fields.has(k));
      return !(missing(x, y) || missing(y, x));
    }
    return true;
  }
  // Two string kinds overlap when one contains the other (handled above); floats likewise.
  return false;
}

// ---------------------------------------------------------------- merging (counts added)

/** `sub`'s values added to `sup`, which contains them: `sup`'s structure, counts summed through it. */
function mergeInto(sup: Shape, sub: Shape): Shape {
  const n = sup.n + sub.n;
  const y = sup.v;
  const x = sub.v;
  if (x.kind === "Never") return sup;
  if (y.kind === "Array" && x.kind === "Array")
    return { n, v: { kind: "Array", element: union([y.element, x.element]) } };
  if (y.kind === "Record") {
    if (x.kind === "Record")
      return { n, v: { kind: "Record", key: union([y.key, x.key]), value: union([y.value, x.value]) } };
    if (x.kind === "Object")
      return {
        n,
        v: {
          kind: "Record",
          key: union([y.key, ...[...x.fields.keys()].map(stringShape)]),
          value: union([y.value, ...[...x.fields.values()].map((f) => f.shape)]),
        },
      };
  }
  if (y.kind === "Object" && x.kind === "Object") {
    const fields = new Map(y.fields);
    for (const [k, f] of x.fields) {
      const g = fields.get(k)!;
      fields.set(k, { shape: union([g.shape, f.shape]), optional: g.optional });
    }
    return { n, v: { kind: "Object", fields } };
  }
  return { n, v: y };
}

/** The union of shapes (counts summed): Convex's `UnionBuilder`. */
export function union(shapes: Shape[]): Shape {
  // The common case, a value like the ones before: straight into the shape that contains it.
  if (shapes.length === 2) {
    const [a, x] = shapes as [Shape, Shape];
    if (a.n > 0 && x.n > 0 && a.v.kind !== "Union" && x.v.kind !== "Union" && isSubtype(x, a)) return mergeInto(a, x);
  }
  const b = new UnionBuilder();
  for (const s of shapes) b.push(s);
  return b.build();
}

export class UnionBuilder {
  private variants: Shape[] = [];

  push(s: Shape) {
    if (s.n === 0 || s.v.kind === "Never") return;
    if (s.v.kind === "Union") {
      for (const x of s.v.variants) this.push(x);
      return;
    }
    // Into a variant that contains it.
    for (let i = 0; i < this.variants.length; i++)
      if (isSubtype(s, this.variants[i]!)) {
        this.variants[i] = mergeInto(this.variants[i]!, s);
        return;
      }
    this.addNew(s);
    while (this.variants.length > MAX_UNION_LENGTH) this.contractOnce();
  }

  /** Convex's `add_new_shape`: absorb the variants it contains; contract what still overlaps it. */
  private addNew(s: Shape) {
    let shape = s;
    for (;;) {
      const absorbed = this.variants.filter((v) => isSubtype(v, shape));
      this.variants = this.variants.filter((v) => !absorbed.includes(v));
      for (const v of absorbed) shape = mergeInto(shape, v);
      const overlapping = this.variants.filter((v) => mayOverlap(v, shape));
      if (!overlapping.length) {
        this.variants.push(shape);
        return;
      }
      this.variants = this.variants.filter((v) => !overlapping.includes(v));
      shape = supertype([shape, ...overlapping]);
    }
  }

  /** Make the union one shorter or more by merging a group of variants, in Convex's candidate order. */
  private contractOnce() {
    const vs = this.variants;
    const pick = (pred: (s: Shape) => boolean) => vs.filter(pred);
    const groups: Shape[][] = [
      pick((s) => s.v.kind === "Array"),
      vs.some((s) => s.v.kind === "Record") ? pick((s) => s.v.kind === "Record" || s.v.kind === "Object") : [],
      ...[...new Set(vs.map(idOf).filter((t): t is number => t !== null))].map((t) => pick((s) => idOf(s) === t)),
      pick((s) => isStringish(s) && isSubtype(s, { n: 0, v: { kind: "FieldName" } })),
      pick(isStringish),
      pick(isFloat),
      pick((s) => s.v.kind === "Object"),
    ];
    const group = groups.find((g) => g.length >= 2) ?? vs;
    this.variants = vs.filter((v) => !group.includes(v));
    this.addNew(supertype(group));
  }

  build(): Shape {
    if (this.variants.length === 0) return NEVER;
    if (this.variants.length === 1) return this.variants[0]!;
    // In Convex's order (a union is an ordered set of shapes, by `ShapeEnum` variant first).
    const variants = [...this.variants].sort((a, b) => RANK.indexOf(a.v.kind) - RANK.indexOf(b.v.kind));
    return { n: variants.reduce((a, s) => a + s.n, 0), v: { kind: "Union", variants } };
  }
}

/** The table an id-like string shape names, or null. */
function idOf(s: Shape): number | null {
  if (s.v.kind === "Id") return s.v.table;
  if (s.v.kind === "StringLiteral") return idTableNumber(s.v.literal);
  return null;
}

/** One shape containing all of `shapes`, counts summed (Convex's `supertype_candidates`, first that fits). */
export function supertype(shapes: Shape[]): Shape {
  const n = shapes.reduce((a, s) => a + s.n, 0);
  const all = (p: (s: Shape) => boolean) => shapes.every(p);
  const kinds = (k: string) => (s: Shape) => s.v.kind === k;
  if (all(kinds("Array")))
    return { n, v: { kind: "Array", element: union(shapes.map((s) => (s.v as { element: Shape }).element)) } };
  const objOrRecord = (s: Shape) => s.v.kind === "Object" || s.v.kind === "Record";
  if (all(objOrRecord) && shapes.some(kinds("Record"))) return toRecord(shapes, n);
  const t = idOf(shapes[0]!);
  if (t !== null && all((s) => idOf(s) === t)) return { n, v: { kind: "Id", table: t } };
  if (all((s) => isStringish(s) && isSubtype(s, { n: 0, v: { kind: "FieldName" } })))
    return { n, v: { kind: "FieldName" } };
  if (all(isStringish)) return { n, v: { kind: "String" } };
  if (all(isFloat)) return { n, v: { kind: "Float64" } };
  if (all(kinds("Object"))) {
    const merged = mergeObjects(shapes, n);
    if (merged) return merged;
  }
  if (all(objOrRecord)) return toRecord(shapes, n);
  return { n, v: { kind: "Unknown" } };
}

/** Objects as one object: a field not in every one becomes optional; null past MAX_OBJECT_FIELDS. */
function mergeObjects(shapes: Shape[], n: number, limit = MAX_OBJECT_FIELDS): Shape | null {
  const objs = shapes.map((s) => s.v as Extract<Variant, { kind: "Object" }>);
  const names = new Set(objs.flatMap((o) => [...o.fields.keys()]));
  if (names.size > limit) return null;
  const fields = new Map<string, { shape: Shape; optional: boolean }>();
  for (const k of [...names].sort()) {
    const present = objs.map((o) => o.fields.get(k)).filter((f) => f !== undefined);
    fields.set(k, {
      shape: union(present.map((f) => f!.shape)),
      optional: present.length < objs.length || present.some((f) => f!.optional),
    });
  }
  return { n, v: { kind: "Object", fields } };
}

function toRecord(shapes: Shape[], n: number): Shape {
  const keys: Shape[] = [];
  const values: Shape[] = [];
  for (const s of shapes) {
    if (s.v.kind === "Record") {
      keys.push(s.v.key);
      values.push(s.v.value);
    } else if (s.v.kind === "Object")
      for (const [k, f] of s.v.fields) {
        keys.push(stringShape(k));
        values.push(f.shape);
      }
  }
  return { n, v: { kind: "Record", key: union(keys), value: union(values) } };
}

// ---------------------------------------------------------------- the dashboard's form

export type DashboardShape =
  | { type: "Unknown" | "Never" | "Null" | "Int64" | "Boolean" | "String" | "Bytes" }
  | { type: "Id"; tableName: string }
  | { type: "Float64"; float64Range: { hasSpecialValues: boolean } }
  | { type: "Object"; fields: { fieldName: string; optional: boolean; shape: DashboardShape }[] }
  | { type: "Array"; shape: DashboardShape }
  | { type: "Record"; keyShape: DashboardShape; valueShape: { optional: boolean; shape: DashboardShape } }
  | { type: "Union"; shapes: DashboardShape[] };

/**
 * The reduced shape `/api/shapes2` sends (Convex's `ReducedShape` and `dashboard_shape_json`): string kinds
 * are `String` (an id of an existing table is `Id`), floats one `Float64` with whether it holds special
 * values, the objects of a union merged into one.
 */
export function reduceShape(s: Shape, tableName: (n: number) => string | undefined): DashboardShape {
  const v = s.v;
  switch (v.kind) {
    case "Never":
    case "Null":
    case "Int64":
    case "Boolean":
    case "Bytes":
    case "Unknown":
      return { type: v.kind };
    case "FieldName":
    case "String":
      return { type: "String" };
    case "StringLiteral":
    case "Id": {
      const t = idOf(s);
      const name = t === null ? undefined : tableName(t);
      return name === undefined ? { type: "String" } : { type: "Id", tableName: name };
    }
    case "NormalFloat64":
      return { type: "Float64", float64Range: { hasSpecialValues: false } };
    case "NegativeInf":
    case "PositiveInf":
    case "NegativeZero":
    case "NaN":
    case "Float64":
      return { type: "Float64", float64Range: { hasSpecialValues: true } };
    case "Array":
      return { type: "Array", shape: reduceShape(v.element, tableName) };
    case "Record":
      return {
        type: "Record",
        keyShape: reduceShape(v.key, tableName),
        valueShape: { optional: hasLiteral(v.key), shape: reduceShape(v.value, tableName) },
      };
    case "Object":
      return {
        type: "Object",
        fields: [...v.fields]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([fieldName, f]) => ({ fieldName, optional: f.optional, shape: reduceShape(f.shape, tableName) })),
      };
    case "Union":
      return reduceUnion(v.variants, tableName);
  }
}

const hasLiteral = (s: Shape): boolean =>
  s.v.kind === "StringLiteral" || (s.v.kind === "Union" && s.v.variants.some(hasLiteral));

function reduceUnion(variants: Shape[], tableName: (n: number) => string | undefined): DashboardShape {
  // In the variants' order: the floats as one Float64 where the first was, the objects as one likewise.
  const out: DashboardShape[] = [];
  const floats = variants.filter(isFloat);
  const objects = variants.filter((s) => s.v.kind === "Object");
  for (const s of variants) {
    let r: DashboardShape;
    if (isFloat(s)) {
      if (s !== floats[0]) continue;
      const special = floats.some((f) => f.v.kind !== "NormalFloat64");
      r = { type: "Float64", float64Range: { hasSpecialValues: special } };
    } else if (s.v.kind === "Object") {
      if (s !== objects[0]) continue;
      // The dashboard's form merges every object, whatever its number of fields.
      r = reduceShape(mergeObjects(objects, 0, Number.POSITIVE_INFINITY)!, tableName);
    } else r = reduceShape(s, tableName);
    if (!out.some((o) => JSON.stringify(o) === JSON.stringify(r))) out.push(r);
  }
  if (out.length === 0) return { type: "Never" };
  if (out.length === 1) return out[0]!;
  return { type: "Union", shapes: out };
}

/** A table's shape from its documents. */
export function tableShape(docs: Iterable<Value>): Shape {
  const b = new UnionBuilder();
  for (const d of docs) b.push(shapeOf(d));
  return b.build();
}

// ---------------------------------------------------------------- removing a value (STUDY-52 PR 2)

/** A shape's value can no longer be found in it: the summary is out of step with the data. */
export class ShapeRemovalError extends Error {}

/**
 * `shape` without one of its values, `value` (Convex's `CountedShape::remove`): the counts along the value's
 * path go down by one; a variant, a field or an element shape whose count reaches 0 disappears, and an
 * optional field present in every remaining object becomes required again. A widened variant (`Float64`,
 * `String`, a record, `Unknown`) is never narrowed back.
 */
export function removeValue(shape: Shape, value: Value): Shape {
  if (shape.n <= 0 || !isSubtype(shapeOf(value), shape)) throw new ShapeRemovalError("value not in shape");
  const n = shape.n - 1;
  if (n === 0) return NEVER;
  const v = shape.v;
  switch (v.kind) {
    case "Union": {
      const i = v.variants.findIndex((s) => isSubtype(shapeOf(value), s));
      if (i < 0) throw new ShapeRemovalError("value not in any variant");
      const b = new UnionBuilder();
      v.variants.forEach((s, j) => {
        b.push(j === i ? removeValue(s, value) : s);
      });
      return b.build();
    }
    case "Array": {
      if (!Array.isArray(value)) throw new ShapeRemovalError("not an array");
      let element = v.element;
      for (const x of value) element = removeValue(element, x);
      return { n, v: { kind: "Array", element } };
    }
    case "Object": {
      const fields = new Map(v.fields);
      for (const [k, x] of Object.entries(value as Record<string, Value>)) {
        if (x === undefined) continue;
        const f = fields.get(k);
        if (!f) throw new ShapeRemovalError(`no field ${k}`);
        const rest = removeValue(f.shape, x);
        if (rest.n === 0) fields.delete(k);
        else fields.set(k, { shape: rest, optional: f.optional });
      }
      // A field every remaining object has is required again.
      for (const [k, f] of fields) if (f.optional && f.shape.n === n) fields.set(k, { ...f, optional: false });
      return { n, v: { kind: "Object", fields } };
    }
    case "Record": {
      let key = v.key;
      let val = v.value;
      for (const [k, x] of Object.entries(value as Record<string, Value>)) {
        if (x === undefined) continue;
        key = removeValue(key, k);
        val = removeValue(val, x);
      }
      return { n, v: { kind: "Record", key, value: val } };
    }
    default:
      return { n, v };
  }
}

/**
 * A shape as Convex's JSON (`CountedShape::to_json`, crates/shape_inference/src/json.rs), as the
 * `table_summary_v2` checkpoint holds it (STUDY-72, STUDY-134): `{numValues, variant}`; a variant's `kind` and
 * its fields by Convex's names — `literal`, `tableNumber`, `elementType`, an object's `fields` as
 * `{fieldName, type: {type, optional}}` in order, a record's `fieldType` / `valueType`, a union's `types`.
 */
export type ShapeJson = { numValues: number; variant: Record<string, unknown> };

export function shapeToJson(s: Shape): ShapeJson {
  const v = s.v;
  let variant: Record<string, unknown>;
  switch (v.kind) {
    case "StringLiteral":
      variant = { kind: v.kind, literal: v.literal };
      break;
    case "Id":
      variant = { kind: v.kind, tableNumber: v.table };
      break;
    case "Array":
      variant = { kind: v.kind, elementType: shapeToJson(v.element) };
      break;
    case "Object":
      variant = {
        kind: v.kind,
        fields: [...v.fields].map(([fieldName, f]) => ({
          fieldName,
          type: { type: shapeToJson(f.shape), optional: f.optional },
        })),
      };
      break;
    case "Record":
      variant = { kind: v.kind, fieldType: shapeToJson(v.key), valueType: shapeToJson(v.value) };
      break;
    case "Union":
      variant = { kind: v.kind, types: v.variants.map(shapeToJson) };
      break;
    default:
      variant = { kind: v.kind };
  }
  return { numValues: s.n, variant };
}

/** `shapeToJson`'s inverse; throws on anything it did not write. */
export function shapeFromJson(j: ShapeJson): Shape {
  const n = j?.numValues;
  if (typeof n !== "number" || typeof j.variant?.kind !== "string") throw new Error("not a shape");
  const v = j.variant as Record<string, any>;
  switch (v.kind) {
    case "Array":
      return { n, v: { kind: "Array", element: shapeFromJson(v.elementType) } };
    case "Object":
      return {
        n,
        v: {
          kind: "Object",
          fields: new Map(
            (v.fields as { fieldName: string; type: { type: ShapeJson; optional: boolean } }[]).map((f) => {
              if (typeof f?.fieldName !== "string") throw new Error("not a shape");
              return [f.fieldName, { shape: shapeFromJson(f.type.type), optional: f.type.optional === true }];
            }),
          ),
        },
      };
    case "Record":
      return { n, v: { kind: "Record", key: shapeFromJson(v.fieldType), value: shapeFromJson(v.valueType) } };
    case "Union":
      return { n, v: { kind: "Union", variants: (v.types as ShapeJson[]).map(shapeFromJson) } };
    case "StringLiteral":
      if (typeof v.literal !== "string") throw new Error("not a shape");
      return { n, v: { kind: "StringLiteral", literal: v.literal } };
    case "Id":
      if (typeof v.tableNumber !== "number") throw new Error("not a shape");
      return { n, v: { kind: "Id", table: v.tableNumber } };
    default:
      if (!RANK.includes(v.kind)) throw new Error("not a shape");
      return { n, v: { kind: v.kind } as Variant };
  }
}
