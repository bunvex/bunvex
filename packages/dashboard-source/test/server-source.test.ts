// The server source's own mappings (STUDY-149 §3.3), where no live server is needed: the schema.
import { describe, expect, test } from "bun:test";
import { schemaInfoOf } from "../src/server-source.ts";

const NONE = { database: [], search: [], vector: [] };

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
      tables: [
        { name: "messages", validator: { type: "object", value: {} }, indexes: NONE },
        { name: "loose", indexes: NONE },
        { name: "bare", indexes: NONE },
      ],
      validation: { state: "validating", numDocsValidated: 1, totalDocs: null },
    });
  });

  test("the declared indexes of every kind, staged ones marked (STUDY-162 §8)", () => {
    const json = JSON.stringify({
      tables: [
        {
          tableName: "docs",
          documentType: null,
          indexes: [{ indexDescriptor: "by_a", fields: ["a"] }],
          stagedDbIndexes: [{ indexDescriptor: "by_b", fields: ["b", "c"] }],
          searchIndexes: [{ indexDescriptor: "search_t", searchField: "t", filterFields: ["a"] }],
          stagedSearchIndexes: [{ indexDescriptor: "search_u", searchField: "u", filterFields: [] }],
          vectorIndexes: [{ indexDescriptor: "by_e", vectorField: "e", dimensions: 3, filterFields: [] }],
        },
      ],
      schemaValidation: true,
    });
    expect(schemaInfoOf(json, undefined).tables[0]!.indexes).toEqual({
      database: [
        { name: "by_a", fields: ["a"], staged: false },
        { name: "by_b", fields: ["b", "c"], staged: true },
      ],
      search: [
        { name: "search_t", searchField: "t", filterFields: ["a"], staged: false },
        { name: "search_u", searchField: "u", filterFields: [], staged: true },
      ],
      vector: [{ name: "by_e", vectorField: "e", dimensions: 3, filterFields: [], staged: false }],
    });
  });

  test("no schema pushed: nothing declared, not enforced", () => {
    expect(schemaInfoOf(undefined, undefined)).toEqual({ enforced: false, tables: [] });
  });
});
