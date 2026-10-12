// The server source's own mappings (STUDY-149 §3.3), where no live server is needed: the schema.
import { describe, expect, test } from "bun:test";
import { schemaInfoOf } from "../src/server-source.ts";

describe("schemaInfoOf", () => {
  test("declared tables with their document types; v.any() and no validator alike; enforcement and progress", () => {
    const json = JSON.stringify({
      tables: [
        { tableName: "messages", documentType: { type: "object", value: {} }, indexes: [] },
        { tableName: "loose", documentType: { type: "any" }, indexes: [] },
        { tableName: "bare", documentType: null, indexes: [] },
      ],
      schemaValidation: false,
    });
    expect(schemaInfoOf(json, { state: "validating", numDocsValidated: 1, totalDocs: null })).toEqual({
      enforced: false,
      tables: [{ name: "messages", validator: { type: "object", value: {} } }, { name: "loose" }, { name: "bare" }],
      validation: { state: "validating", numDocsValidated: 1, totalDocs: null },
    });
  });

  test("no schema pushed: nothing declared, not enforced", () => {
    expect(schemaInfoOf(undefined, undefined)).toEqual({ enforced: false, tables: [] });
  });
});
