// A validator's JSON parsed as Convex's backend parses it (STUDY-105 E2): `serde_json` into `ValidatorJson`
// (crates/common/src/schemas/json.rs), then `Validator::try_from` with its checks and messages. Isomorphic:
// `exportedValidator` (builders.ts) uses it.
//
// - Shape: what serde would refuse (an unknown `type`, a missing or mistyped field) is Convex's `invalid_json`,
//   whose message is "Invalid JSON" whatever serde said (json_trait/src/lib.rs `json_deserialize`).
// - Meaning: literals, table names, field names and record keys, in Convex's order (an object's fields in key
//   order, as its `BTreeMap`) and words.
import { displayValue, fromJsonValue, type JSONValue, type Value } from "@bunvex/values";
import { checkIdentifier } from "./function-path.ts";

/** Convex's `invalid_json` message: every serde failure reads the same. */
export const INVALID_JSON = "Invalid JSON";

type Json = JSONValue;
const isObject = (x: unknown): x is Record<string, Json> => typeof x === "object" && x !== null && !Array.isArray(x);

/** The `type`s `ValidatorJson` takes (`map` and `set` are aliases of `any`). */
const SIMPLE = new Set(["null", "number", "bigint", "commitTs", "boolean", "string", "bytes", "any", "map", "set"]);

/** Whether serde would deserialize `j` as a `ValidatorJson`. */
function isValidatorShape(j: unknown): boolean {
  if (!isObject(j) || typeof j.type !== "string") return false;
  if (SIMPLE.has(j.type)) return true;
  switch (j.type) {
    case "literal":
      return "value" in j;
    case "id":
      return typeof j.tableName === "string";
    case "array":
      return isValidatorShape(j.value);
    case "record":
      return isValidatorShape(j.keys) && isFieldShape(j.values);
    case "object":
      return isObject(j.value) && Object.values(j.value).every(isFieldShape);
    case "union":
      return Array.isArray(j.value) && j.value.every(isValidatorShape);
    default:
      return false;
  }
}
const isFieldShape = (j: unknown) => isObject(j) && typeof j.optional === "boolean" && isValidatorShape(j.fieldType);

/** A failure of `Validator::try_from`: its message. */
class Invalid extends Error {}

/**
 * Convex's `Display` for a validator (crates/common/src/schemas/validator.rs), for the record-key message:
 * `v.string()`, `v.literal("a")`, a bigint literal as `<bigint>`.
 */
function display(j: Record<string, Json>): string {
  switch (j.type) {
    case "number":
      return "v.float64()";
    case "bigint":
      return "v.int64()";
    case "map":
    case "set":
      return "v.any()";
    case "id":
      return `v.id("${j.tableName as string}")`;
    case "literal": {
      const value = fromJsonValue(j.value as Json);
      return `v.literal(${typeof value === "bigint" ? "<bigint>" : displayValue(value)})`;
    }
    case "array":
      return `v.array(${display(j.value as Record<string, Json>)})`;
    case "record":
      return `v.record(${display(j.keys as Record<string, Json>)}, ${display((j.values as Record<string, Json>).fieldType as Record<string, Json>)})`;
    case "object":
      return `v.object({${Object.keys(j.value as Record<string, Json>)
        .sort()
        .map((k) => {
          const f = (j.value as Record<string, Record<string, Json>>)[k]!;
          const inner = display(f.fieldType as Record<string, Json>);
          return `${k}: ${f.optional ? `v.optional(${inner})` : inner}`;
        })
        .join(", ")}})`;
    case "union":
      return `v.union(${(j.value as Record<string, Json>[]).map(display).join(", ")})`;
    default:
      return `v.${j.type as string}()`;
  }
}

/** Convex's `is_subset(&Validator::String)`, for a record's keys. */
function isStringSubset(j: Record<string, Json>): boolean {
  switch (j.type) {
    case "string":
    case "id":
      return true;
    case "literal":
      return typeof j.value === "string";
    case "union":
      return (j.value as Record<string, Json>[]).every(isStringSubset);
    default:
      return false;
  }
}

/** Convex's `is_string_subtype_with_string_literal`. */
function hasStringLiteral(j: Record<string, Json>): boolean {
  if (j.type === "literal") return typeof j.value === "string";
  if (j.type === "union") return (j.value as Record<string, Json>[]).some(hasStringLiteral);
  return false;
}

/** A character as Rust's `{:?}` shows it: `'é'`, `'\n'`, `'\u{1}'`. */
function rustChar(c: string): string {
  const named: Record<string, string> = {
    "\t": "\\t",
    "\n": "\\n",
    "\r": "\\r",
    "\0": "\\0",
    "'": "\\'",
    "\\": "\\\\",
  };
  if (named[c]) return `'${named[c]}'`;
  const code = c.codePointAt(0)!;
  return code < 0x20 || (code >= 0x7f && code < 0xa0) ? `'\\u{${code.toString(16)}}'` : `'${c}'`;
}

/** Convex's `check_valid_field_name`, then `check_valid_identifier` (`IdentifierFieldName::from_str`). */
function fieldNameError(s: string): string | null {
  if (s.startsWith("$")) return `Field name ${s} starts with '$', which is reserved.`;
  for (const c of s) {
    const code = c.codePointAt(0)!;
    if (code > 0x7f || code < 0x20 || code === 0x7f)
      return `Field name ${s} has invalid character ${rustChar(c)}: Field names can only contain non-control ASCII characters`;
  }
  if (s.length > 1024) return `Field name is too long (${s.length} > maximum 1024)`;
  return checkIdentifier(s);
}

/** `Validator::try_from` on a shape serde accepted. */
function check(j: Record<string, Json>): void {
  switch (j.type) {
    case "literal": {
      let value: Value;
      try {
        value = fromJsonValue(j.value as Json);
      } catch (e) {
        throw new Invalid((e as Error).message);
      }
      if (!["number", "bigint", "boolean", "string"].includes(typeof value))
        throw new Invalid(`Value ${displayValue(value)} is not a valid literal.`);
      return;
    }
    case "id": {
      const error = checkIdentifier(j.tableName as string);
      if (error) throw new Invalid(error);
      return;
    }
    case "array":
      check(j.value as Record<string, Json>);
      return;
    case "record": {
      const keys = j.keys as Record<string, Json>;
      check(keys);
      if (!isStringSubset(keys))
        throw new Invalid(
          `Records can only have string keys. Your validator contains a record with key typed as \`${display(keys)}\`, which is not a subtype of \`v.string()\``,
        );
      const values = j.values as Record<string, Json>;
      check(values.fieldType as Record<string, Json>);
      if (hasStringLiteral(keys)) throw new Invalid("Records cannot have string literal keys");
      if (values.optional) throw new Invalid("Records cannot have optional values");
      return;
    }
    case "object": {
      const fields = j.value as Record<string, Record<string, Json>>;
      for (const k of Object.keys(fields).sort()) {
        const error = fieldNameError(k);
        if (error) throw new Invalid(error);
        try {
          check(fields[k]!.fieldType as Record<string, Json>);
        } catch (e) {
          throw e instanceof Invalid ? new Invalid(`Invalid validator for key \`${k}\`: ${e.message}`) : e;
        }
      }
      return;
    }
    case "union":
      for (const m of j.value as Record<string, Json>[]) check(m);
      return;
  }
}

/**
 * The JSON Convex serializes a parsed validator back to (`TryFrom<Validator> for ValidatorJson`): only the
 * fields its type has, an object's fields in key order, `map` and `set` as `any`.
 */
function canonical(j: Record<string, Json>): Record<string, Json> {
  const field = (f: Record<string, Json>) => ({
    fieldType: canonical(f.fieldType as Record<string, Json>),
    optional: f.optional as boolean,
  });
  switch (j.type) {
    case "map":
    case "set":
      return { type: "any" };
    case "literal":
      return { type: "literal", value: j.value as Json };
    case "id":
      return { type: "id", tableName: j.tableName as string };
    case "array":
      return { type: "array", value: canonical(j.value as Record<string, Json>) };
    case "record":
      return {
        type: "record",
        keys: canonical(j.keys as Record<string, Json>),
        values: field(j.values as Record<string, Json>),
      };
    case "object": {
      const fields = j.value as Record<string, Record<string, Json>>;
      return {
        type: "object",
        value: Object.fromEntries(
          Object.keys(fields)
            .sort()
            .map((k) => [k, field(fields[k]!)]),
        ),
      };
    }
    case "union":
      return { type: "union", value: (j.value as Record<string, Json>[]).map(canonical) };
    default:
      return { type: j.type as string };
  }
}

/**
 * Convex's `ArgsValidator` / `ReturnsValidator` from their JSON text (crates/model/src/modules/
 * function_validators.rs): the JSON Convex stores for it, or the reason it is refused.
 *
 * - Args: a validator, which must be an object or `any`.
 * - Returns: `null` (unvalidated) or a validator.
 *
 * A validator that does not parse is "Error in args validator: …" (or returns). Convex adds a line linking to
 * its docs, left out (DV-357).
 */
export function parseValidatorJson(text: string, kind: "args" | "returns"): { json: string } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: INVALID_JSON };
  }
  if (kind === "returns" && parsed === null) return { json: "null" };
  if (!isValidatorShape(parsed)) return { error: INVALID_JSON };
  const j = parsed as Record<string, Json>;
  try {
    check(j);
  } catch (e) {
    if (!(e instanceof Invalid)) throw e;
    return { error: `Error in ${kind} validator: ${e.message}` };
  }
  const out = canonical(j);
  if (kind === "args" && out.type !== "object" && out.type !== "any")
    return { error: "Args validator must be an object or any" };
  return { json: JSON.stringify(out) };
}
