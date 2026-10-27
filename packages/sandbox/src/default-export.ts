// A push-time evaluation's default export across the wire (`Executor.evaluateDefault`). The live export cannot
// leave the child, so the child sends the form its use takes, as Convex's isolate does: the auth config as its
// `JSON.stringify` (crates/isolate/src/environment/auth_config.rs:286), a schema as its export
// (environment/schema.rs:271-293). The host turns that back into what the push reads.
import { schemaFromJson, schemaToJson } from "@bunvex/core";
import { type DefaultExportUse, isSchemaDefinition, UnserializableAuthConfigError } from "@bunvex/server/executor";
import type { EvaluatedDefault } from "./protocol.ts";

/** The child's side: a default export, in the form its use takes. */
export function exportDefault(value: unknown, use: DefaultExportUse): EvaluatedDefault {
  if (use === "authConfig") {
    // The push reads none and `null` alike: a missing export (Convex's `is_null_or_undefined`).
    if (value === undefined || value === null) return { kind: "undefined" };
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch {
      return { kind: "unserializable" };
    }
    // A function, a symbol, a `toJSON` that gives `undefined`: an export, but no JSON.
    return json === undefined ? { kind: "notJson" } : { kind: "json", json };
  }
  // The push reads none, `null` and `undefined` alike: a missing schema export.
  if (value === undefined || value === null) return { kind: "undefined" };
  if (!isSchemaDefinition(value)) return { kind: "notSchema" };
  try {
    return { kind: "schema", json: JSON.stringify(schemaToJson(value)) };
  } catch {
    return { kind: "schemaExportFailed" };
  }
}

/**
 * Not a schema: what the host hands the push for a default export that is not one, or whose export fails. The push
 * refuses both with the same error (`InvalidSchemaExport`): it checks the export right after the default
 * (`schemaExport`, then `checkIndexReferences`).
 */
export const NOT_A_SCHEMA: unknown = Object.freeze({});

/**
 * An auth config with no JSON (`notJson`): what the host hands the push for it, a value `JSON.stringify` gives none
 * for either, so the push refuses it as it refuses the live value under `vm`.
 */
export const NOT_JSON: unknown = Symbol("auth config without JSON");

/** The host's side: what the push reads of a default export the child sent. */
export function evaluatedValue(e: EvaluatedDefault): unknown {
  switch (e.kind) {
    case "undefined":
      return undefined;
    case "json":
      return JSON.parse(e.json);
    case "notJson":
      return NOT_JSON;
    case "unserializable":
      throw new UnserializableAuthConfigError();
    case "schema":
      return schemaFromJson(JSON.parse(e.json));
    case "notSchema":
    case "schemaExportFailed":
      return NOT_A_SCHEMA;
  }
}
