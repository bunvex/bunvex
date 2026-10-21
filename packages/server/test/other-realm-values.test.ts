// Values from a function's own realm in the server's checks (STUDY-182 §3): pushed code runs in its own `vm`
// context, whose `ArrayBuffer` and `Error` are not the server's, so `instanceof` misses them. Bytes written by
// pushed code were summarised as an object in a table's shape.
import { describe, expect, test } from "bun:test";
import vm from "node:vm";
import { shapeOf } from "@bunvex/core";
import { toExportJson, type Value } from "@bunvex/values";
import { cleanJson } from "../src/audit-log.ts";
import { parseFormat, writeValue } from "../src/streaming-export.ts";

const other = vm.createContext({});
const bytes = vm.runInContext("new Uint8Array([1, 2, 3]).buffer", other) as ArrayBuffer;
const mine = new Uint8Array([1, 2, 3]).buffer;

describe("bytes from another realm", () => {
  test("are not this realm's ArrayBuffer", () => {
    expect(bytes instanceof ArrayBuffer).toBe(false);
  });

  test("a table's shape: Bytes", () => {
    expect(shapeOf(bytes as Value)).toEqual(shapeOf(mine));
    expect(shapeOf({ b: bytes } as Value)).toEqual(shapeOf({ b: mine }));
  });

  test("the audit log's JSON, the export's and the streaming export's: base64 bytes", () => {
    expect(cleanJson(bytes as Value)).toBe("AQID");
    expect(toExportJson({ b: bytes } as Value)).toBe(toExportJson({ b: mine }));
    const f = parseFormat("json");
    expect(writeValue(bytes as Value, f)).toBe(writeValue(mine, f));
  });
});
