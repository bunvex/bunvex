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
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch {
      return { kind: "unserializable" };
    }
    return json === undefined ? { kind: "undefined" } : { kind: "json", json };
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

/** The host's side: what the push reads of a default export the child sent. */
export function evaluatedValue(e: EvaluatedDefault): unknown {
  switch (e.kind) {
    case "undefined":
      return undefined;
    case "json":
      return JSON.parse(e.json);
    case "unserializable":
      throw new UnserializableAuthConfigError();
    case "schema":
      return schemaFromJson(JSON.parse(e.json));
    case "notSchema":
    case "schemaExportFailed":
      return NOT_A_SCHEMA;
  }
}
