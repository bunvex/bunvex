// The wire (STUDY-171 §7.2): frames split and joined at any chunk boundary, refused from their header when over
// the limit; a child's messages checked for their shape; a version and a default export across the wire as the
// in-process loader made them.
import { describe, expect, test } from "bun:test";
import { defineSchema, defineTable, schemaToJson } from "@bunvex/core";
import { CodeVersion } from "@bunvex/server/executor";
import { v } from "@bunvex/values";
import { exportDefault } from "../src/default-export.ts";
import {
  BadMessageError,
  describeVersion,
  evaluatedValue,
  FrameReader,
  FrameTooLargeError,
  frame,
  loadedVersion,
  MAX_MESSAGE_BYTES,
  MAX_VALUE_SIZE,
  NOT_A_SCHEMA,
  parseChildMessage,
} from "../src/index.ts";

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
};

describe("frames", () => {
  const messages = [{ t: "a" }, { t: "b", s: "ünïcödé ☃ 𝄞" }, { t: "c", big: "x".repeat(70_000) }, {}];
  const stream = concat(messages.map(frame));

  test("every split of the stream gives the same messages", () => {
    for (const size of [1, 2, 3, 4, 5, 7, 64, 4096, stream.byteLength]) {
      const reader = new FrameReader();
      const out: unknown[] = [];
      for (let i = 0; i < stream.byteLength; i += size)
        for (const text of reader.push(stream.subarray(i, i + size))) out.push(JSON.parse(text as string));
      expect(out).toEqual(messages);
      expect(reader.pending).toBe(0);
    }
  });

  test("a frame over the limit fails from its header alone", () => {
    const reader = new FrameReader(100);
    expect(reader.push(frame({ t: "small" }))).toEqual(['{"t":"small"}']);
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, 101, true);
    expect(() => reader.push(header)).toThrow(new FrameTooLargeError(101, 100));
  });

  test("a frame of exactly the limit is read", () => {
    const text = JSON.stringify({ t: "x".repeat(92) });
    expect(new TextEncoder().encode(text).byteLength).toBe(100);
    expect(new FrameReader(100).push(frame(JSON.parse(text)))).toEqual([text]);
  });

  test("a frame that is not UTF-8 fails", () => {
    expect(() => new FrameReader().push(new Uint8Array([2, 0, 0, 0, 0xff, 0xfe]))).toThrow("not UTF-8");
  });

  test("the limit leaves room for the JSON of any value within Convex's 16 MiB caps", () => {
    expect(MAX_VALUE_SIZE).toBe(16 * 1024 * 1024);
    // The worst case per counted byte: an empty bytes value (2 counted, `{"$bytes":""},` sent) and a control
    // character (1 counted, `\u0001` sent).
    expect(JSON.stringify({ $bytes: "" }).length + 1).toBeLessThanOrEqual(7 * 2);
    expect(JSON.stringify("\u0001").length - 2).toBeLessThanOrEqual(7 * 1);
    expect(MAX_MESSAGE_BYTES).toBeGreaterThan(7 * MAX_VALUE_SIZE);
  });
});

describe("a child's messages", () => {
  test("the handshake and the answers parse", () => {
    expect(parseChildMessage('{"t":"hello","protocol":1,"pid":5}')).toEqual({ t: "hello", protocol: 1, pid: 5 });
    expect(parseChildMessage('{"t":"failed","id":1,"error":{"kind":"InvalidModules","detail":"x"}}')).toEqual({
      t: "failed",
      id: 1,
      error: { kind: "InvalidModules", detail: "x" },
    });
  });

  test.each([
    ["[1]", "message: expected an object"],
    ['{"t":"call","id":1}', 'message.t: expected "hello" or "loaded" or "evaluated" or "failed"'],
    ['{"t":"loaded","id":-1}', "loaded.id: expected a non-negative integer"],
    ['{"t":"loaded","id":1,"version":{"analysis":{}}}', "loaded.version.analysis: expected an array"],
    [
      '{"t":"loaded","id":1,"loadMs":1,"version":{"analysis":[],"moduleHashes":[],"moduleLoads":[],"functions":[],"rooms":[]}}',
      "loaded.held: expected a non-negative integer",
    ],
    [
      '{"t":"loaded","id":1,"loadMs":1,"version":{"analysis":[["m.js",{"functions":[{"name":"q","pos":null,"udfType":"Thing"}]}]]}}',
      'loaded.version.analysis[0][1].functions[0].udfType: expected "Query" or "Mutation" or "Action"',
    ],
    ['{"t":"evaluated","id":1,"loadMs":1,"export":{"kind":"json"}}', "evaluated.export.json: expected a string"],
    ['{"t":"failed","id":1,"error":{"kind":"Panic"}}', "failed.error.kind: expected"],
    ["{nope", "not JSON"],
  ])("%s is refused: %s", (text, why) => {
    expect(() => parseChildMessage(text)).toThrow(BadMessageError);
    expect(() => parseChildMessage(text)).toThrow(why);
  });

  test("a cron's schedule may hold its type's fields only", () => {
    const loaded = (schedule: unknown) =>
      JSON.stringify({
        t: "loaded",
        id: 1,
        loadMs: 1,
        held: 1,
        version: {
          analysis: [
            [
              "crons.js",
              {
                functions: [],
                httpRoutes: null,
                rooms: [],
                cronSpecs: [["c", { udfPath: "m.js:f", udfArgs: [{}], cronSchedule: schedule }]],
              },
            ],
          ],
          moduleHashes: [],
          moduleLoads: [],
          functions: [],
          rooms: [],
        },
      });
    expect(() => parseChildMessage(loaded({ type: "daily", hourUTC: 3, minuteUTC: 5 }))).not.toThrow();
    expect(() => parseChildMessage(loaded({ type: "daily", hourUTC: 3, extra: 1 }))).toThrow(
      "extra: expected no such field",
    );
    expect(() => parseChildMessage(loaded({ type: "cron", cronExpr: 5 }))).toThrow("cronExpr: expected a string");
    expect(() => parseChildMessage(loaded({ type: "yearly" }))).toThrow("type: expected");
  });
});

describe("a version across the wire", () => {
  test("is the in-process analysis, values and order kept", async () => {
    const sources = [
      {
        path: "m.js",
        environment: "isolate" as const,
        source: `import { mutation, query, internalAction } from "bunvex/server";
          export const z = query(async () => 1);
          export const a = mutation(async () => 1);
          export const b = internalAction(async () => 1);`,
      },
      {
        path: "crons.js",
        environment: "isolate" as const,
        source: `import { cronJobs } from "bunvex/server";
          const c = cronJobs();
          c.daily("d", { hourUTC: 1, minuteUTC: 2 }, "m:a", { n: 1n, b: new Uint8Array([1, 2]).buffer });
          export default c;`,
      },
    ];
    const version = await CodeVersion.load(sources, { seed: new Uint32Array(4), timestamp: 0 });
    const wire = parseChildMessage(
      JSON.stringify({ t: "loaded", id: 1, loadMs: 1, held: 1, version: describeVersion(version) }),
    );
    if (wire.t !== "loaded") throw new Error(wire.t);
    const loaded = loadedVersion(wire.version);
    expect(loaded.analysis).toEqual(version.analysis);
    expect(loaded.analysis["crons.js"]!.cronSpecs!.d!.udfArgs).toEqual([{ n: 1n, b: new Uint8Array([1, 2]).buffer }]);
    expect([...loaded.functions.keys()]).toEqual([...version.functions.keys()]);
    expect(loaded.moduleHashes).toEqual(version.moduleHashes);
    expect(loaded.moduleLoads).toEqual(version.moduleLoads);
  });

  test("a module path such as __proto__ is a key like any other", () => {
    const analysis = [["__proto__", { functions: [], httpRoutes: null, cronSpecs: null, rooms: [] }]];
    const wire = parseChildMessage(
      JSON.stringify({
        t: "loaded",
        id: 1,
        loadMs: 1,
        held: 1,
        version: { analysis, moduleHashes: [], moduleLoads: [], functions: [], rooms: [] },
      }),
    );
    if (wire.t !== "loaded") throw new Error(wire.t);
    const loaded = loadedVersion(wire.version);
    expect(Object.getPrototypeOf(loaded.analysis)).toBe(Object.prototype);
    expect(Object.keys(loaded.analysis)).toEqual(["__proto__"]);
  });
});

describe("a default export across the wire", () => {
  const schema = defineSchema({ messages: defineTable({ body: v.string() }).index("by_body", ["body"]) });

  test("a schema: its export, rebuilt", () => {
    const sent = exportDefault(schema, "schema");
    expect(sent.kind).toBe("schema");
    expect(schemaToJson(evaluatedValue(sent) as typeof schema)).toEqual(schemaToJson(schema));
  });

  test("not a schema, none, and one whose export fails", () => {
    expect(exportDefault(undefined, "schema")).toEqual({ kind: "undefined" });
    expect(exportDefault(null, "schema")).toEqual({ kind: "undefined" });
    expect(exportDefault({ tables: 1 }, "schema")).toEqual({ kind: "notSchema" });
    expect(evaluatedValue({ kind: "notSchema" })).toBe(NOT_A_SCHEMA);
    const broken = {
      ...schema,
      tables: new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("no");
          },
        },
      ),
    };
    expect(exportDefault(broken, "schema")).toEqual({ kind: "schemaExportFailed" });
  });

  test("an auth config: its JSON, as Convex's isolate stringifies it", () => {
    const config = { providers: [{ domain: "https://a.example.com", applicationID: "app", skipped: undefined }] };
    expect(evaluatedValue(exportDefault(config, "authConfig"))).toEqual({
      providers: [{ domain: "https://a.example.com", applicationID: "app" }],
    });
    expect(exportDefault(undefined, "authConfig")).toEqual({ kind: "undefined" });
    expect(exportDefault({ n: 1n }, "authConfig")).toEqual({ kind: "unserializable" });
    expect(() => evaluatedValue({ kind: "unserializable" })).toThrow("auth config file can only contain strings");
  });
});
