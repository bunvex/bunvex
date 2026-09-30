// Validators in Convex's JSON form (STUDY-12 V1–V2): shown as the `v.*` code that declared them, turned into
// a template value (a function's arguments to start from), and checked against a value — each problem with
// the path to where it is, so an editor can underline it. Written for bunvex from Convex's observable
// behaviour (its dashboard's runner and document editor), not from its code.
import type { Json, ObjectFieldJson, ValidatorJson, Value } from "./data-source.ts";
import { formatLiteral } from "./database/literal.ts";
import { decodeInt64, encodeInt64, valueType } from "./filters.ts";

// ------------------------------------------------------------------ display

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));

function literalText(v: Json | { $integer: string }): string {
  if (typeof v === "object" && v !== null && !Array.isArray(v) && "$integer" in v)
    return `${decodeInt64(v as { $integer: string })}n`;
  return formatLiteral(v as Value);
}

const field = (f: ObjectFieldJson, indent: string, width: number) => {
  const inner = displayValidator(f.fieldType, { indent, width });
  return f.optional ? `v.optional(${inner})` : inner;
};

/**
 * A validator as the `v.*` code that declares it: on one line when it fits in `width` columns, otherwise an
 * object's fields (and a union's members) one per line.
 */
export function displayValidator(v: ValidatorJson, opts: { indent?: string; width?: number } = {}): string {
  const indent = opts.indent ?? "";
  const width = opts.width ?? 72;
  const flat = flatValidator(v);
  if (indent.length + flat.length <= width) return flat;
  const inner = `${indent}  `;
  switch (v.type) {
    case "object": {
      const entries = Object.entries(v.value);
      if (entries.length === 0) return flat;
      const lines = entries.map(([k, f]) => `${inner}${key(k)}: ${field(f, inner, width)},`);
      return `v.object({\n${lines.join("\n")}\n${indent}})`;
    }
    case "union":
      return `v.union(\n${v.value.map((m) => `${inner}${displayValidator(m, { indent: inner, width })},`).join("\n")}\n${indent})`;
    case "array":
      return `v.array(${displayValidator(v.value, { indent, width })})`;
    case "record":
      return `v.record(${flatValidator(v.keys)}, ${field(v.values, indent, width)})`;
    default:
      return flat;
  }
}

function flatValidator(v: ValidatorJson): string {
  switch (v.type) {
    case "null":
      return "v.null()";
    case "number":
      return "v.float64()";
    case "bigint":
      return "v.int64()";
    case "boolean":
      return "v.boolean()";
    case "string":
      return "v.string()";
    case "bytes":
      return "v.bytes()";
    case "any":
      return "v.any()";
    case "literal":
      return `v.literal(${literalText(v.value)})`;
    case "id":
      return `v.id(${JSON.stringify(v.tableName)})`;
    case "array":
      return `v.array(${flatValidator(v.value)})`;
    case "record": {
      const value = flatValidator(v.values.fieldType);
      return `v.record(${flatValidator(v.keys)}, ${v.values.optional ? `v.optional(${value})` : value})`;
    }
    case "object": {
      const entries = Object.entries(v.value);
      if (entries.length === 0) return "v.object({})";
      const fields = entries.map(([k, f]) => {
        const inner = flatValidator(f.fieldType);
        return `${key(k)}: ${f.optional ? `v.optional(${inner})` : inner}`;
      });
      return `v.object({ ${fields.join(", ")} })`;
    }
    case "union":
      return `v.union(${v.value.map(flatValidator).join(", ")})`;
  }
}

// ------------------------------------------------------------------ a template

/**
 * A value to start from: what each required field would hold when empty (`""`, `0`, `0n`, `false`, `[]`,
 * `{}`, a literal's value, a union's first member); optional fields are left out.
 */
export function defaultValueFor(v: ValidatorJson): Value | undefined {
  switch (v.type) {
    case "null":
      return null;
    case "string":
    case "id":
      return "";
    case "number":
      return 0;
    case "bigint":
      return encodeInt64(0n);
    case "boolean":
      return false;
    case "bytes":
      return { $bytes: "" };
    case "any":
    case "record":
      return {};
    case "array":
      return [];
    case "literal":
      return v.value as Value;
    case "object": {
      const out: Record<string, Value> = {};
      for (const [k, f] of Object.entries(v.value)) {
        if (f.optional) continue;
        const d = defaultValueFor(f.fieldType);
        if (d !== undefined) out[k] = d;
      }
      return out;
    }
    case "union":
      // an empty union admits nothing: null, and let the reader see the error
      return v.value.length === 0 ? null : defaultValueFor(v.value[0]!);
  }
}

// ------------------------------------------------------------------ checking

export type ValidatorPath = (string | number)[];

/**
 * A value that does not fit. `at` says where to point: the property's key (`key`, for one that should not be
 * there), or the value at `path` (`value`; for a missing property, the object that lacks it).
 */
export type ValidationIssue = { path: ValidatorPath; at: "key" | "value"; message: string };

/** Convex's name for a value's type in its messages. */
function typeName(v: Value): string {
  const t = valueType(v);
  return t === "int64" ? "bigint" : t;
}

const prefix = (path: ValidatorPath) => (path.length === 0 ? "" : `${path.join(".")}: `);

/** Every place `value` does not fit `v`, outermost first. An empty list: it fits. */
export function validateValue(v: ValidatorJson, value: Value, path: ValidatorPath = []): ValidationIssue[] {
  const mismatch = (): ValidationIssue[] => [
    {
      path,
      at: "value",
      message: `${prefix(path)}Type '${typeName(value)}' is not assignable to ${flatValidator(v)}`,
    },
  ];
  const t = valueType(value);
  switch (v.type) {
    case "any":
      return [];
    case "null":
    case "number":
    case "boolean":
    case "string":
    case "bytes":
      return t === v.type ? [] : mismatch();
    case "bigint":
      return t === "int64" ? [] : mismatch();
    case "id":
      // the table cannot be checked from an id's text; that it is text can
      return t === "string" ? [] : mismatch();
    case "literal":
      return JSON.stringify(value) === JSON.stringify(v.value) ? [] : mismatch();
    case "array":
      return Array.isArray(value) ? value.flatMap((x, i) => validateValue(v.value, x, [...path, i])) : mismatch();
    case "record": {
      if (t !== "object") return mismatch();
      return Object.entries(value as Record<string, Value>).flatMap(([k, x]) => [
        ...(validateValue(v.keys, k, [...path, k]).length > 0
          ? [
              {
                path: [...path, k],
                at: "key" as const,
                message: `${prefix(path)}Key '${k}' is not assignable to ${flatValidator(v.keys)}`,
              },
            ]
          : []),
        ...validateValue(v.values.fieldType, x, [...path, k]),
      ]);
    }
    case "object": {
      if (t !== "object") return mismatch();
      const obj = value as Record<string, Value>;
      const issues: ValidationIssue[] = [];
      for (const [k, f] of Object.entries(v.value))
        if (!(k in obj) && !f.optional)
          issues.push({
            path,
            at: "value",
            message: `${prefix(path)}Property '${k}' is missing but required: ${flatValidator(f.fieldType)}`,
          });
      for (const [k, x] of Object.entries(obj)) {
        const f = v.value[k];
        if (!f)
          issues.push({
            path: [...path, k],
            at: "key",
            message: `${prefix(path)}Property '${k}' does not exist in ${flatValidator(v)}`,
          });
        else issues.push(...validateValue(f.fieldType, x, [...path, k]));
      }
      return issues;
    }
    case "union":
      return v.value.some((m) => validateValue(m, value, path).length === 0)
        ? []
        : [{ path, at: "value", message: `${prefix(path)}Value does not match any type in ${flatValidator(v)}` }];
  }
}

// ------------------------------------------------------------------ shape

const TYPES = new Set(["null", "number", "bigint", "boolean", "string", "bytes", "any", "literal", "id"]);

/** Whether `x` is a validator in Convex's JSON form (for sources and the contract suite). */
export function isValidatorJson(x: unknown): x is ValidatorJson {
  if (typeof x !== "object" || x === null) return false;
  const v = x as Record<string, unknown>;
  switch (v.type) {
    case "literal":
      return "value" in v;
    case "id":
      return typeof v.tableName === "string";
    case "array":
      return isValidatorJson(v.value);
    case "union":
      return Array.isArray(v.value) && v.value.every(isValidatorJson);
    case "record": {
      const values = v.values as Record<string, unknown> | undefined;
      return (
        isValidatorJson(v.keys) && typeof values === "object" && values !== null && isValidatorJson(values.fieldType)
      );
    }
    case "object":
      return (
        typeof v.value === "object" &&
        v.value !== null &&
        Object.values(v.value as Record<string, unknown>).every(
          (f) =>
            typeof f === "object" &&
            f !== null &&
            typeof (f as ObjectFieldJson).optional === "boolean" &&
            isValidatorJson((f as ObjectFieldJson).fieldType),
        )
      );
    default:
      return typeof v.type === "string" && TYPES.has(v.type);
  }
}
