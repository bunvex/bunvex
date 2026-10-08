// Convex's `Validator::is_subset` and `Validator::from_shape` (crates/common/src/schemas/validator.rs), over the
// validator JSON a schema stores (`ValidatorJSON`: `number` is float64, `bigint` int64). A push uses them to decide
// whether a table's documents must be walked against its new validator (`TableValidationOutcome`, STUDY-106 §7.4):
// a validator that accepts everything the old one did, or everything the table's shape says it holds, needs no walk.
// `isSubset` may answer false when the answer is true (a walk that was not needed), never true when it is false.
import type { Shape } from "./shapes.ts";

type V = { type: string; [k: string]: unknown };
type Field = { fieldType: V; optional: boolean };

const ANY: V = { type: "any" };

/** A document validator (`DocumentSchema`) as a validator: `any`, or a union of its objects (one object alone too). */
export function documentValidator(json: V | undefined): V {
  if (json === undefined || json.type === "any") return ANY;
  return json.type === "union" ? json : { type: "union", value: [json] };
}

/** A literal's kind, as Convex's `LiteralValidator`: a string, an int64 (`{$integer}`), a float64, a boolean. */
function literalKind(value: unknown): "string" | "bigint" | "number" | "boolean" {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "bigint";
}

/** Structural equality: object fields in any order, union members in order, a record's value without `optional`. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v === null || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (o.type === "record")
    return { type: "record", keys: canonical(o.keys), values: canonical((o.values as Field).fieldType) };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) out[k] = canonical(o[k]);
  return out;
}
const equal = (a: V, b: V) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** Whether every value `a` accepts, `b` accepts too (Convex's match arms, in their order). */
export function isSubset(a: V, b: V): boolean {
  if (a.type === "array" && b.type === "array") return isSubset(a.value as V, b.value as V);
  if (a.type === "object" && b.type === "object") {
    const left = a.value as Record<string, Field>;
    const right = b.value as Record<string, Field>;
    // No field disappears; every right field is a non-breaking change of a left one, or a new optional field.
    if (!Object.keys(left).every((k) => k in right)) return false;
    return Object.entries(right).every(([k, r]) => {
      const l = left[k];
      return l === undefined ? r.optional : (!l.optional || r.optional) && isSubset(l.fieldType, r.fieldType);
    });
  }
  if (equal(a, b)) return true;
  if (b.type === "any") return true;
  if (a.type === "literal" && literalKind(a.value) === b.type) return true;
  if (a.type === "id" && b.type === "string") return true;
  if (a.type === "union") return (a.value as V[]).every((c) => isSubset(c, b));
  if (b.type === "union") {
    if ((b.value as V[]).some((c) => isSubset(a, c))) return true;
    // boolean ⊆ true | false
    return (
      a.type === "boolean" &&
      isSubset({ type: "literal", value: true }, b) &&
      isSubset({ type: "literal", value: false }, b)
    );
  }
  return false;
}

/** The validator a table's shape implies (Convex's `from_shape`); an id of a table not mapped is a string. */
export function validatorFromShape(shape: Shape, tableName: (tableNumber: number) => string | undefined): V {
  const v = shape.v;
  switch (v.kind) {
    case "Never":
      return { type: "union", value: [] };
    case "Null":
      return { type: "null" };
    case "Int64":
      return { type: "bigint" };
    case "Float64":
    case "NegativeInf":
    case "PositiveInf":
    case "NegativeZero":
    case "NaN":
    case "NormalFloat64":
      return { type: "number" };
    case "Boolean":
      return { type: "boolean" };
    case "StringLiteral":
      return { type: "literal", value: v.literal };
    case "Id": {
      const name = tableName(v.table);
      return name === undefined ? { type: "string" } : { type: "id", tableName: name };
    }
    case "FieldName":
    case "String":
      return { type: "string" };
    case "Bytes":
      return { type: "bytes" };
    case "Array":
      return { type: "array", value: validatorFromShape(v.element, tableName) };
    case "Object": {
      const value: Record<string, Field> = {};
      for (const [k, f] of v.fields)
        value[k] = { fieldType: validatorFromShape(f.shape, tableName), optional: f.optional };
      return { type: "object", value };
    }
    case "Record":
      return {
        type: "record",
        keys: validatorFromShape(v.key, tableName),
        values: { fieldType: validatorFromShape(v.value, tableName), optional: false },
      };
    case "Union":
      return { type: "union", value: v.variants.map((s) => validatorFromShape(s, tableName)) };
    case "Unknown":
      return ANY;
  }
}

/** Without `_id` and `_creationTime` at the top (Convex's `filter_top_level_system_fields`). */
export function withoutSystemFields(v: V): V {
  if (v.type === "object") {
    const value = { ...(v.value as Record<string, Field>) };
    delete value._id;
    delete value._creationTime;
    return { type: "object", value };
  }
  if (v.type === "union") return { type: "union", value: (v.value as V[]).map(withoutSystemFields) };
  return v;
}

export type TableOutcome =
  | "notValidated"
  | "supersetOfEnforced"
  | "supersetOfStagedValidated"
  | "supersetOfShape"
  | "mustWalk";

/**
 * Convex's `validation_outcome_for_validator`, in its order: no validation; the new validator accepts everything the
 * active one enforced (`any` when the active schema does not validate or has no such table); it accepts everything
 * the active schema's staged validator for the table accepts, one its validation proved (`valid`, kept true by every
 * write being checked: 7236c10); it accepts everything the table's shape holds (skipped without a shape: table
 * summaries not built); else the table must be walked.
 */
export function tableValidationOutcome(
  schemaValidation: boolean,
  next: V,
  enforced: V | undefined,
  shape: Shape | undefined,
  tableName: (tableNumber: number) => string | undefined,
  validStaged?: V,
): TableOutcome {
  if (!schemaValidation) return "notValidated";
  const n = documentValidator(next);
  if (isSubset(documentValidator(enforced), n)) return "supersetOfEnforced";
  if (validStaged !== undefined && isSubset(documentValidator(validStaged), n)) return "supersetOfStagedValidated";
  if (shape !== undefined && isSubset(withoutSystemFields(validatorFromShape(shape, tableName)), n))
    return "supersetOfShape";
  return "mustWalk";
}
