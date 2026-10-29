// Values from a function's own realm in the server's checks (STUDY-182 §3): pushed code runs in its own `vm`
// context, whose `ArrayBuffer` and `Error` are not the server's, so `instanceof` misses them. Bytes written by
// pushed code were summarised as an object in a table's shape.
import { afterEach, describe, expect, test } from "bun:test";
import vm from "node:vm";
import { defineSchema, Engine, shapeOf } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { toExportJson, type Value } from "@bunvex/values";
import { cleanJson } from "../src/audit-log.ts";
import { Functions } from "../src/functions.ts";
import type { LogEvent } from "../src/log-events.ts";
import { createServer } from "../src/server.ts";
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

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

describe("an error from another realm", () => {
  test("the log stream's exception event keeps its message and frames", async () => {
    const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
    const functions = new Functions(engine);
    const s = createServer({ engine, functions, port: 0, deployable: true, fileStorage: null });
    stops.push(() => s.shutdown());
    await s.codeReady;
    const SERVER = JSON.stringify(["@bunvex", "server"].join("/"));
    await s.deployCode([
      {
        path: "m.js",
        source: `import { query } from ${SERVER};\nexport const boom = query(async () => { throw new Error("boom"); });`,
        environment: "isolate",
      },
    ]);
    const raw: LogEvent[] = [];
    functions.logManager = { active: true, send: (e: LogEvent[]) => raw.push(...e) } as never;
    await functions.runQuery("m:boom", {}).catch(() => {});
    const exception = raw.find((e) => e.event.topic === "exception")?.event as
      | { message: string; frames: unknown[] }
      | undefined;
    expect(exception?.message).toBe("boom");
    expect(exception?.frames.length).toBeGreaterThan(0);
  });
});
