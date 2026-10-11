// Query-string and body errors as Convex's extractors give them (`common/src/http/extract.rs`): serde's
// messages through serde_path_to_error, behind axum's prefixes, and read before the route's operation check.
// The same requests are compared with Convex's binary in packages/differential/test/parse-errors.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { Functions } from "../src/functions.ts";
import { BadJsonBody, type BodyShape, parseJsonBody } from "../src/json-body.ts";
import { queryArgs } from "../src/query-args.ts";
import { createServer } from "../src/server.ts";
import { selectionOf } from "../src/streaming-export.ts";

const DATA = "Failed to deserialize the JSON body into the target type: ";
const QUERY = "Failed to deserialize query string: ";

const error = (text: string, shape: BodyShape) => {
  try {
    parseJsonBody(text, shape);
    return null;
  } catch (e) {
    if (e instanceof BadJsonBody) return e.message;
    throw e;
  }
};

describe("body kinds, as serde reads them", () => {
  const shape: BodyShape = {
    name: "Args",
    fields: [
      ["n", { option: { int: "u64" } }],
      ["small", { option: { int: "u16" } }],
      ["signed", { option: { int: "i64" } }],
      ["flag", { option: { bool: true } }],
      ["names", { option: { list: "string" } }],
      ["kind", { default: { variants: ["a", "b"] } }],
      ["mode", { option: { variants: ["x", "y", "z"] } }],
      ["nested", { option: { object: "Nested" } }],
    ],
  };
  test("integers: type, range and floats", () => {
    expect(error('{"n":"x"}', shape)).toBe(`${DATA}n: invalid type: string "x", expected u64 at line 1 column 8`);
    expect(error('{"n":-1}', shape)).toBe(`${DATA}n: invalid value: integer \`-1\`, expected u64 at line 1 column 7`);
    expect(error('{"n":1.5}', shape)).toBe(
      `${DATA}n: invalid type: floating point \`1.5\`, expected u64 at line 1 column 8`,
    );
    expect(error('{"small":70000}', shape)).toBe(
      `${DATA}small: invalid value: integer \`70000\`, expected u16 at line 1 column 14`,
    );
    expect(error('{"signed":-5}', shape)).toBeNull();
    // Past 2^53 a valid integer is still accepted (`JSON.parse` rounds it; routes that need it exact read the text).
    expect(error('{"n":18446744073709551615}', shape)).toBeNull();
    expect(error('{"n":18446744073709551616}', shape)).toContain("invalid type: floating point");
  });
  test("booleans, lists, variants, nested structs", () => {
    expect(error('{"flag":1}', shape)).toBe(
      `${DATA}flag: invalid type: integer \`1\`, expected a boolean at line 1 column 9`,
    );
    expect(error('{"names":[1]}', shape)).toBe(
      `${DATA}names[0]: invalid type: integer \`1\`, expected a string at line 1 column 11`,
    );
    expect(error('{"kind":"c"}', shape)).toBe(
      `${DATA}kind: unknown variant \`c\`, expected \`a\` or \`b\` at line 1 column 11`,
    );
    expect(error('{"mode":"w"}', shape)).toBe(
      `${DATA}mode: unknown variant \`w\`, expected one of \`x\`, \`y\`, \`z\` at line 1 column 11`,
    );
    expect(error('{"nested":5}', shape)).toBe(
      `${DATA}nested: invalid type: integer \`5\`, expected struct Nested at line 1 column 11`,
    );
    expect(error('{"mode":null,"names":null}', shape)).toBeNull();
  });
  test("a field given twice, the array form, a flattened struct, a tagged enum", () => {
    const one: BodyShape = { name: "One", fields: [["id", "string"]] };
    expect(error('{"id":"a","id":"b"}', one)).toBe(`${DATA}duplicate field \`id\` at line 1 column 14`);
    expect(error("[]", one)).toBe(`${DATA}invalid length 0, expected struct One with 1 element at line 1 column 2`);
    expect(error("[]", { ...one, flatten: true })).toBe(
      `${DATA}invalid type: sequence, expected struct One at line 1 column 0`,
    );
    const tagged: BodyShape = { name: "Args", fields: [], tagged: { tag: "type", variants: ["a", "b"] } };
    expect(error("{}", tagged)).toBe(`${DATA}missing field \`type\` at line 1 column 2`);
    expect(error('{"type":"c"}', tagged)).toBe(
      `${DATA}type: unknown variant \`c\`, expected \`a\` or \`b\` at line 1 column 11`,
    );
    expect(error("5", tagged)).toBe(
      `${DATA}invalid type: integer \`5\`, expected internally tagged enum Args at line 1 column 1`,
    );
    expect(error('{"type":"a","x":1}', tagged)).toBeNull();
  });
});

test("streaming export's `SelectionArg` is untagged: arguments that make no selection select everything", () => {
  const everything = { _other: "included" } as const;
  expect(selectionOf({ selection: 5 })).toEqual(everything);
  expect(selectionOf({ tableName: 5 })).toEqual(everything);
  expect(selectionOf({ tableName: "t", component: 5 })).toEqual(everything);
  expect(selectionOf({ tableName: "t" })).toEqual({
    _other: "excluded",
    "": { _other: "excluded", t: { _other: "included" } },
  });
  expect(() => selectionOf({ tableName: "" })).toThrow("Invalid table name");
});

describe("query strings, as serde_urlencoded reads them", () => {
  const fields = [
    ["from", { int: "u64" }],
    ["limit", { int: "usize" }, true],
    ["on", "bool", true],
    ["format", { variants: ["csv", "zip"] }, true],
  ] as const;
  const err = (q: string) => {
    try {
      queryArgs(new URLSearchParams(q), [...fields] as never);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  test("Rust's integer parse, booleans, variants, missing and duplicate fields", () => {
    expect(err("")).toBe(`${QUERY}missing field \`from\``);
    expect(err("from=x")).toBe(`${QUERY}from: invalid digit found in string`);
    expect(err("from=")).toBe(`${QUERY}from: cannot parse integer from empty string`);
    expect(err("from=-1")).toBe(`${QUERY}from: invalid digit found in string`);
    expect(err("from=99999999999999999999")).toBe(`${QUERY}from: number too large to fit in target type`);
    expect(err("from=0&on=1")).toBe(`${QUERY}on: provided string was not \`true\` or \`false\``);
    expect(err("from=0&format=x")).toBe(`${QUERY}format: unknown variant \`x\`, expected \`csv\` or \`zip\``);
    expect(err("from=0&from=1")).toBe(`${QUERY}duplicate field \`from\``);
    expect(err("from=0&limit=5&other=x")).toBeNull();
  });
});

describe("routes: the arguments before the operation's check", () => {
  const SECRET = "3c".repeat(32);
  const KEY = issueAdminKey({ instanceName: "parse-errors", cipherKey: adminKeyCipherKey(SECRET) });
  const stops: (() => unknown)[] = [];
  afterEach(async () => {
    for (const s of stops.splice(0)) await s();
  });
  const setup = async () => {
    const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false }), {
      instanceName: "parse-errors",
      instanceSecret: SECRET,
    }).init();
    const s = createServer({ engine, functions: new Functions(engine), port: 0, sitePort: null });
    stops.push(s.stop);
    const api = `http://127.0.0.1:${s.server!.port}`;
    return async (method: string, path: string, body?: string, key: string | null = null) => {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers["content-type"] = "application/json";
      if (key) headers.authorization = `Bunvex ${key}`;
      const r = await fetch(`${api}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
      const text = await r.text();
      return { status: r.status, body: text === "" ? "" : JSON.parse(text) };
    };
  };
  test("a bad body or query string without a key is the parse error, not BadDeployKey", async () => {
    const req = await setup();
    expect(await req("POST", "/api/cancel_job", "{}")).toEqual({
      status: 400,
      body: { code: "BadJsonBody", message: `${DATA}missing field \`id\` at line 1 column 2` },
    });
    expect((await req("POST", "/api/cancel_job", '{"id":"x"}')).body.code).toBe("BadDeployKey");
    expect(await req("GET", "/api/v1/list_audit_log_events")).toEqual({
      status: 400,
      body: { code: "BadQueryArgs", message: `${QUERY}missing field \`from\`` },
    });
    expect((await req("POST", "/api/v1/update_canonical_url", '{"requestDestination":"x"}')).body.message).toBe(
      `${DATA}requestDestination: unknown variant \`x\`, expected \`bunvexCloud\` or \`bunvexSite\` at line 1 column 25`,
    );
    expect((await req("POST", "/api/v1/create_log_stream", '{"logStreamType":"webhook"}')).body.message).toBe(
      `${DATA}missing field \`url\``,
    );
  });
  test("the audit log: a cursor that does not parse; set_expiration keeps nanoseconds exact", async () => {
    const req = await setup();
    expect(await req("GET", "/api/v1/list_audit_log_events?from=0&cursor=5", undefined, KEY)).toEqual({
      status: 400,
      body: { code: "InvalidCursor", message: "Failed to parse cursor" },
    });
    expect((await req("POST", "/api/export/set_expiration/x", '{"expirationTsNs":"1"}', KEY)).body.message).toBe(
      `${DATA}expirationTsNs: invalid type: string "1", expected u64 at line 1 column 21`,
    );
  });
});
