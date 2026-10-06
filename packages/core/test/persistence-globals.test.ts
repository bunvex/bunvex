// The persistence globals' values as Convex writes them (STUDY-134, DV-426): the retention timestamps as
// `{"$integer": …}` of nanoseconds, and `table_summary_v2` with `JsonInteger` strings and Convex's shape JSON —
// compared with the globals of a Convex deployment (convex-rows/globals.json).
import { afterEach, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import { fromJsonInteger, jsonInteger, readTsGlobal, tsGlobal } from "../src/persistence-globals.ts";
import { RETENTION_GLOBALS } from "../src/retention.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import { type Shape, shapeFromJson, shapeOf, shapeToJson } from "../src/shapes.ts";
import { TABLE_SUMMARY_GLOBAL } from "../src/table-summary-checkpoint.ts";
import { convexGlobals, shapeDiff } from "./convex-rows/shape.ts";

const schema = defineSchema({ t: defineTable(v.any()) });
const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close().catch(() => {});
});

async function open() {
  const p = new SqlitePersistence(":memory:", { durable: false });
  const e = await new Engine(schema, p, {
    retention: { background: false, indexDelayMs: 0, documentDelayMs: 0, checkpointEveryMs: 0 },
  }).init();
  engines.push(e);
  await e.summariesReady();
  return { e, p };
}

test("the retention globals: an int64 of nanoseconds, as Convex's", async () => {
  const { e, p } = await open();
  await e.mutation((db) => db.insert("t", { a: 1 }));
  await e.mutation((db) => db.insert("t", { a: 2 }));
  await e.retention!.advance();
  await e.retention!.deleteIndexes();
  await e.retention!.deleteDocuments();
  const convex = convexGlobals();
  for (const key of Object.values(RETENTION_GLOBALS)) {
    const value = p.getGlobal(key);
    expect(shapeDiff(value, convex[key])).toEqual([]);
    expect(value).toHaveProperty("$integer");
  }
  // Nanoseconds: the µs window × 1000, read back as it was.
  const min = p.getGlobal(RETENTION_GLOBALS.minIndexTs);
  expect(min).toEqual(tsGlobal(e.retention!.minIndexTs));
  expect(readTsGlobal(min)).toBe(e.retention!.minIndexTs);
  expect(readTsGlobal(convex[RETENTION_GLOBALS.minIndexTs])).toBe(1791233764257871);
});

test("table_summary_v2: JsonInteger strings and Convex's shape JSON", async () => {
  const { e, p } = await open();
  await e.mutation((db) => db.insert("t", { a: 1 }));
  await e.summaryCheckpointer!.tick(true);
  const ours = (await p.getGlobal(TABLE_SUMMARY_GLOBAL)) as { ts: string; tables: Record<string, unknown> };
  const convex = convexGlobals().table_summary_v2 as { ts: string; tables: Record<string, unknown> };
  // The tables are keyed by tablet, bunvex's numbers (Convex: its tablet ids; DV-428, STUDY-133).
  expect(shapeDiff(ours, convex, ["tables"])).toEqual([]);
  // `_tables`' own summary against Convex's.
  const tablesTablet = String(e.catalog.tables.get("_tables")!.id);
  expect(shapeDiff(ours.tables[tablesTablet], convex.tables["ca0vqcsTaoYPWanyp_ZQ-w"])).toEqual([]);
  // The ts in nanoseconds: the summaries' µs × 1000.
  expect(fromJsonInteger(ours.ts) % 1000n).toBe(0n);
  expect(Number(fromJsonInteger(ours.ts) / 1000n)).toBeLessThanOrEqual(e.committer.visibleTs);
  expect(fromJsonInteger(convex.ts)).toBe(1791233999266279000n);
});

test("every shape variant in Convex's JSON form, and back", () => {
  const id = { n: 2, v: { kind: "Id", table: 10001 } } as Shape;
  const shape: Shape = {
    n: 3,
    v: {
      kind: "Object",
      fields: new Map([
        ["s", { shape: { n: 3, v: { kind: "StringLiteral", literal: "x" } }, optional: false }],
        ["i", { shape: id, optional: true }],
        ["a", { shape: { n: 3, v: { kind: "Array", element: shapeOf(1) } }, optional: false }],
        ["r", { shape: { n: 1, v: { kind: "Record", key: shapeOf("k"), value: shapeOf(1n) } }, optional: true }],
        ["u", { shape: { n: 3, v: { kind: "Union", variants: [shapeOf(null), shapeOf(true)] } }, optional: false }],
      ]),
    },
  };
  const json = shapeToJson(shape);
  // Convex's `CountedShape::to_json` (crates/shape_inference/src/json.rs).
  expect(json).toEqual({
    numValues: 3,
    variant: {
      kind: "Object",
      fields: [
        {
          fieldName: "s",
          type: { type: { numValues: 3, variant: { kind: "StringLiteral", literal: "x" } }, optional: false },
        },
        {
          fieldName: "i",
          type: { type: { numValues: 2, variant: { kind: "Id", tableNumber: 10001 } }, optional: true },
        },
        {
          fieldName: "a",
          type: {
            type: {
              numValues: 3,
              variant: { kind: "Array", elementType: { numValues: 1, variant: { kind: "NormalFloat64" } } },
            },
            optional: false,
          },
        },
        {
          fieldName: "r",
          type: {
            type: {
              numValues: 1,
              variant: {
                kind: "Record",
                fieldType: shapeToJson(shapeOf("k")),
                valueType: { numValues: 1, variant: { kind: "Int64" } },
              },
            },
            optional: true,
          },
        },
        {
          fieldName: "u",
          type: {
            type: {
              numValues: 3,
              variant: {
                kind: "Union",
                types: [
                  { numValues: 1, variant: { kind: "Null" } },
                  { numValues: 1, variant: { kind: "Boolean" } },
                ],
              },
            },
            optional: false,
          },
        },
      ],
    },
  });
  expect(shapeFromJson(JSON.parse(JSON.stringify(json)))).toEqual(shape);
});

test("JsonInteger: base64 of the little-endian int64, as Convex's", () => {
  expect(jsonInteger(1791233999266279000n)).toBe("WG7e+9S92xg=");
  expect(jsonInteger(0n)).toBe("AAAAAAAAAAA=");
  expect(fromJsonInteger("KhAAAAAAAAA=")).toBe(4138n);
  expect(() => fromJsonInteger("4138")).toThrow();
});
