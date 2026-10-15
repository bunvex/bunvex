// What the Data screen's editors check as you type (STUDY-163 §3), as Convex's object editor does: the documents (or
// the field) against the table's declared type in the schema (`useToolPopup`'s `documentType`, the cell editor's
// `validatorForColumn`). A misfit is an error that blocks saving when the schema is enforced, and a warning that
// does not when it is not (Convex's `shouldSurfaceValidatorErrors = schemaValidation`, `setErrorMarkers`).
import type { SchemaInfo, ValidatorJson, Value } from "../data-source.ts";
import { flatValidator, validateValue } from "../validators.ts";
import type { LiteralPlace } from "./literal.ts";

/** A misfit, where it is in the text. */
export type SchemaIssue = { message: string; offset: number };

/** A table's declared document type, and whether the schema is enforced; null when the table declares none. */
export type TableSchema = { validator: ValidatorJson; enforced: boolean };

export function tableSchema(schema: SchemaInfo | undefined, table: string): TableSchema | null {
  const validator = schema?.tables.find((t) => t.name === table)?.validator;
  return validator ? { validator, enforced: schema!.enforced } : null;
}

/** A field's own type in a table's type, and whether it may be left out; null for a field it does not declare. */
export function fieldSchema(t: TableSchema | null, field: string): (TableSchema & { optional: boolean }) | null {
  if (t?.validator.type !== "object") return null;
  const f = t.validator.value[field];
  return f ? { validator: f.fieldType, optional: f.optional, enforced: t.enforced } : null;
}

/**
 * Each place `value` does not fit `validator`, at its offset in the text it was parsed from (`place`, from
 * `parseLiteralLocated`); `base` is where `value` is in that text's value (a document's index in a list).
 */
export function schemaIssues(
  validator: ValidatorJson,
  value: Value,
  place: (path: (string | number)[]) => LiteralPlace | undefined,
  base: (string | number)[] = [],
): SchemaIssue[] {
  return validateValue(validator, value).map((issue) => {
    const at = place([...base, ...issue.path]);
    const which = base.length > 0 ? `Document ${Number(base[0]) + 1}: ` : "";
    return {
      message: `${which}${issue.message}`,
      offset: (issue.at === "key" ? at?.key : undefined) ?? at?.value ?? 0,
    };
  });
}

/** A field emptied (removed) that the schema requires (Convex's `RequiredPropertyMissing` for a cell). */
export const requiredFieldIssue = (validator: ValidatorJson): SchemaIssue => ({
  message: `Value is missing but required: ${flatValidator(validator)}`,
  offset: 0,
});

/**
 * How the issues show: enforced, the first is the editor's error (Save blocked) and the rest more errors; not
 * enforced, all of them are warnings, with a note that saving is still allowed.
 */
export function issueDisplay(issues: SchemaIssue[], enforced: boolean) {
  if (issues.length === 0) return { error: undefined, moreErrors: undefined, warnings: undefined, note: undefined };
  if (enforced) return { error: issues[0], moreErrors: issues.slice(1), warnings: undefined, note: undefined };
  const n = issues.length;
  return {
    error: undefined,
    moreErrors: undefined,
    warnings: issues,
    note: `${n === 1 ? "A value does" : `${n} values do`} not match the schema, which is not enforced: ${issues[0]!.message}`,
  };
}
