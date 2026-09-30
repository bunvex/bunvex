// Checking a value against a validator (STUDY-13), with the rules and the message structure of Convex's
// `Validator::check_value` (crates/common/src/schemas/validator.rs): a path from the outermost level, the
// value and the validator in the same display forms.
import { decodeId } from "./id.ts";
import type { GenericValidator } from "./validators.ts";
import { compareValues, isSimpleObject, type Value } from "./value.ts";

/** An id's table name, or undefined when it names no known table (the engine's catalog answers). */
export type TableOfId = (tableNumber: number) => string | undefined;

/** Display a value as the messages do: `1.0`, `NaN`, `"s"`, `5n`→`5`, `[1, 2]`, `{a: 1}`. */
export function displayValue(v: Value | undefined): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "NaN";
    if (v === Number.POSITIVE_INFINITY) return "inf";
    if (v === Number.NEGATIVE_INFINITY) return "-inf";
    if (Object.is(v, -0)) return "-0.0";
    return Number.isInteger(v) && Math.abs(v) < 1e16 ? `${v}.0` : String(v);
  }
  if (typeof v === "boolean") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (v instanceof ArrayBuffer) return `ArrayBuffer(${v.byteLength} bytes)`;
  if (Array.isArray(v)) return `[${v.map(displayValue).join(", ")}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${k}: ${displayValue((v as Record<string, Value>)[k])}`)
    .join(", ")}}`;
}

/** Display a validator as the messages do: `v.string()`, `v.object({a: v.optional(v.float64())})`. */
export function displayValidator(x: GenericValidator): string {
  switch (x.kind) {
    case "id":
      return `v.id(${JSON.stringify(x.tableName)})`;
    case "literal":
      return `v.literal(${displayValue(x.value as Value)})`;
    case "array":
      return `v.array(${displayValidator(x.element)})`;
    case "record":
      return `v.record(${displayValidator(x.key)}, ${displayValidator(x.value)})`;
    case "union":
      return `v.union(${x.members.map(displayValidator).join(", ")})`;
    case "object":
      return `v.object({${Object.keys(x.fields)
        .sort()
        .map((k) => {
          const f = x.fields[k];
          return `${k}: ${f.isOptional === "optional" ? `v.optional(${displayValidator(f)})` : displayValidator(f)}`;
        })
        .join(", ")}})`;
    default:
      return `v.${x.kind}()`;
  }
}

class Mismatch {
  path: string[] = []; // innermost first
  constructor(readonly render: (path: string) => string) {}
  at(p: string) {
    this.path.push(p);
    return this;
  }
  message() {
    const path = this.path.length ? `Path: ${[...this.path].reverse().join("")}` : "";
    return this.render(path);
  }
}

const noMatch = (value: Value | undefined, x: GenericValidator) =>
  new Mismatch(
    (path) =>
      `Value does not match validator.\n${path}\nValue: ${displayValue(value)}\nValidator: ${displayValidator(x)}`,
  );

function check(x: GenericValidator, value: Value | undefined, tableOf: TableOfId): Mismatch | null {
  // biome-ignore lint/suspicious/noExplicitAny: the composite parts are validators
  const part = (p: any) => p as GenericValidator;
  switch (x.kind) {
    case "any":
      return null;
    case "null":
      return value === null ? null : noMatch(value, x);
    case "float64":
      return typeof value === "number" ? null : noMatch(value, x);
    case "int64":
      return typeof value === "bigint" ? null : noMatch(value, x);
    case "boolean":
      return typeof value === "boolean" ? null : noMatch(value, x);
    case "string":
      return typeof value === "string" ? null : noMatch(value, x);
    case "bytes":
      return value instanceof ArrayBuffer ? null : noMatch(value, x);
    case "id": {
      if (typeof value !== "string") return noMatch(value, x);
      let number: number;
      try {
        number = decodeId(value).tableNumber;
      } catch {
        return noMatch(value, x);
      }
      const found = tableOf(number);
      if (found === undefined) return noMatch(value, x);
      if (found === x.tableName) return null;
      if (found.startsWith("_"))
        return new Mismatch(
          (path) =>
            `Found ID "${value}" from a system table, which does not match the table name in validator \`v.id("${x.tableName}")\`.${path}`,
        );
      return new Mismatch(
        (path) =>
          `Found ID "${value}" from table \`${found}\`, which does not match the table name in validator \`v.id("${x.tableName}")\`.${path}`,
      );
    }
    case "literal":
      return value !== undefined && typeof value === typeof x.value && compareValues(value, x.value as Value) === 0
        ? null
        : new Mismatch(
            (path) =>
              `\`${displayValue(value)}\` does not match literal validator \`v.literal(${displayValue(x.value as Value)})\`.${path}`,
          );
    case "array": {
      if (!Array.isArray(value)) return noMatch(value, x);
      for (let i = 0; i < value.length; i++) {
        const m = check(part(x.element), value[i], tableOf);
        if (m) return m.at(`[${i}]`);
      }
      return null;
    }
    case "record": {
      if (!isSimpleObject(value)) return noMatch(value, x);
      for (const [k, val] of Object.entries(value as Record<string, Value>)) {
        const mk = check(part(x.key), k, tableOf);
        if (mk) return mk.at(".keys()");
        const mv = check(part(x.value), val, tableOf);
        if (mv) return mv.at(".values()");
      }
      return null;
    }
    case "object": {
      if (!isSimpleObject(value)) return noMatch(value, x);
      const obj = value as Record<string, Value>;
      for (const name of Object.keys(x.fields).sort()) {
        const f = part(x.fields[name]);
        if (name in obj && obj[name] !== undefined) {
          const m = check(f, obj[name], tableOf);
          if (m) return m.at(`.${name}`);
        } else if (f.isOptional !== "optional")
          return new Mismatch(
            (path) =>
              `Object is missing the required field \`${name}\`. Consider wrapping the field validator in \`v.optional(...)\` if this is expected.\n${path}\nObject: ${displayValue(obj)}\nValidator: ${displayValidator(x)}`,
          );
      }
      for (const name of Object.keys(obj).sort())
        if (obj[name] !== undefined && !(name in x.fields))
          return new Mismatch(
            (path) =>
              `Object contains extra field \`${name}\` that is not in the validator.\n${path}\nObject: ${displayValue(obj)}\nValidator: ${displayValidator(x)}`,
          );
      return null;
    }
    case "union": {
      if (x.members.length === 1) return check(part(x.members[0]), value, tableOf);
      for (const m of x.members) if (!check(part(m), value, tableOf)) return null;
      return noMatch(value, x);
    }
  }
  return noMatch(value, x);
}

/** Check `value` against `validator`: null when it matches, else the error message. */
export function checkValue(
  validator: GenericValidator,
  value: Value | undefined,
  tableOf: TableOfId = () => undefined,
) {
  return check(validator, value, tableOf)?.message() ?? null;
}
