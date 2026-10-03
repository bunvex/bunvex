// The HTTP function API's request errors (STUDY-67 H4, H5): Content-Type, the body as Convex's `Json`
// extractor reads it, the method, and `/api/function`'s admin check. Every expected message is what Convex's
// local backend answered for the same request (STUDY-67 §5).
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { Functions, internalQuery, query } from "../src/functions.ts";
import { isJsonContentType, parseJsonBody, UDF_POST } from "../src/json-body.ts";
import { createServer } from "../src/server.ts";

const SECRET = "4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974";
const cipherKey = adminKeyCipherKey(SECRET);
const KEY = issueAdminKey({ instanceName: "probe", cipherKey });
const SYSTEM = issueAdminKey({ instanceName: "probe", cipherKey, system: true });
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: "probe", instanceSecret: SECRET },
  ).init();
  const functions = new Functions(engine).register("m", {
    ok: query(async () => "ok"),
    secret: internalQuery(async () => "internal"),
  });
  const s = createServer({ engine, functions, port: 0, sitePort: null });
  stops.push(s.stop);
  const base = `http://127.0.0.1:${s.server!.port}`;
  const post = async (
    route: string,
    body: string,
    headers: Record<string, string> = { "content-type": "application/json" },
  ) => {
    const r = await fetch(`${base}/api/${route}`, { method: "POST", headers, body });
    const text = await r.text();
    return { status: r.status, body: text === "" ? null : JSON.parse(text) };
  };
  return { base, post };
}

const bad = (message: string) => ({ status: 400, body: { code: "BadJsonBody", message } });
const PARSE = "Failed to parse the request body as JSON: ";
const SHAPE = "Failed to deserialize the JSON body into the target type: ";

describe("Content-Type", () => {
  test("required, as application/json or application/*+json, parameters allowed", async () => {
    const { post } = await setup();
    const body = JSON.stringify({ path: "m:ok", args: {} });
    const expected = bad("Expected request with `Content-Type: application/json`");
    expect(await post("query", body, {})).toEqual(expected);
    expect(await post("query", body, { "content-type": "text/plain" })).toEqual(expected);
    for (const ct of ["application/json", "Application/JSON", "application/json; charset=utf-8", "application/ld+json"])
      expect((await post("query", body, { "content-type": ct })).body).toEqual({ status: "success", value: "ok" });
  });

  test("isJsonContentType", () => {
    expect(isJsonContentType(null)).toBe(false);
    for (const ct of ["text/json", "application/jsonx", "application/x-json", "application", ""])
      expect(isJsonContentType(ct)).toBe(false);
  });
});

describe("the body", () => {
  test("over HTTP: syntax and shape errors, `args` required, extra fields ignored", async () => {
    const { post } = await setup();
    expect(await post("query", "{nope")).toEqual(bad(`${PARSE}key must be a string at line 1 column 2`));
    expect(await post("query", '{"path":"m:ok"}')).toEqual(bad(`${SHAPE}missing field \`args\` at line 1 column 15`));
    expect(await post("query", '{"args":{}}')).toEqual(bad(`${SHAPE}missing field \`path\` at line 1 column 11`));
    expect(await post("query_at_ts", '{"path":"m:ok","args":{}}')).toEqual(
      bad(`${SHAPE}missing field \`ts\` at line 1 column 25`),
    );
    expect(
      await post("function", '{"path":"m:ok","args":{},"componentPath":5}', {
        "content-type": "application/json",
        authorization: `Bunvex ${KEY}`,
      }),
    ).toEqual(bad(`${SHAPE}componentPath: invalid type: integer \`5\`, expected a string at line 1 column 42`));
    expect((await post("query", '{"path":"m:ok","args":{},"x":1}')).body.value).toBe("ok");
    // serde takes a struct written as an array of its fields, in order.
    expect((await post("query", '["m:ok",{},null]')).body.value).toBe("ok");
  });

  // Each body and the message Convex's backend gave for it.
  const cases: [string, string][] = [
    ["", `${PARSE}EOF while parsing a value at line 1 column 0`],
    [" ", `${PARSE}EOF while parsing a value at line 1 column 1`],
    ["x", `${PARSE}expected value at line 1 column 1`],
    ["{", `${PARSE}EOF while parsing an object at line 1 column 1`],
    ['{"a" 1}', `${PARSE}expected \`:\` at line 1 column 6`],
    ['{"a":1 2}', `${PARSE}expected \`,\` or \`}\` at line 1 column 8`],
    ["[1 2]", `${SHAPE}[0]: invalid type: integer \`1\`, expected a string at line 1 column 2`],
    ["{} x", `${SHAPE}missing field \`path\` at line 1 column 2`],
    ['{"a":}', `${PARSE}a: expected value at line 1 column 6`],
    ['{"a":1,}', `${PARSE}trailing comma at line 1 column 8`],
    ['"abc', `${PARSE}EOF while parsing a string at line 1 column 4`],
    ["tru", `${PARSE}EOF while parsing a value at line 1 column 3`],
    ["trux", `${PARSE}expected ident at line 1 column 4`],
    ["-", `${PARSE}EOF while parsing a value at line 1 column 1`],
    ["01", `${PARSE}invalid number at line 1 column 2`],
    ["1.", `${PARSE}EOF while parsing a value at line 1 column 2`],
    ["1.x", `${PARSE}invalid number at line 1 column 3`],
    ['"a\u0001"', `${PARSE}control character (\\u0000-\\u001F) found while parsing a string at line 1 column 3`],
    ['"\\q"', `${PARSE}invalid escape at line 1 column 3`],
    ['"\\ud800"', `${PARSE}unexpected end of hex escape at line 1 column 8`],
    ['"\\uzzzz"', `${PARSE}invalid escape at line 1 column 7`],
    ['{\n  "path": 5\n}', `${SHAPE}path: invalid type: integer \`5\`, expected a string at line 2 column 11`],
    ['{"path":null,"args":{}}', `${SHAPE}path: invalid type: null, expected a string at line 1 column 12`],
    ['{"path":true,"args":{}}', `${SHAPE}path: invalid type: boolean \`true\`, expected a string at line 1 column 12`],
    [
      '{"path":1.5,"args":{}}',
      `${SHAPE}path: invalid type: floating point \`1.5\`, expected a string at line 1 column 11`,
    ],
    ['{"path":-5,"args":{}}', `${SHAPE}path: invalid type: integer \`-5\`, expected a string at line 1 column 10`],
    [
      '{"path":18446744073709551616,"args":{}}',
      `${SHAPE}path: invalid type: floating point \`1.8446744073709552e+19\`, expected a string at line 1 column 28`,
    ],
    ['{"path":1e400,"args":{}}', `${PARSE}path: number out of range at line 1 column 13`],
    ['{"path":{"a":1},"args":{}}', `${SHAPE}path: invalid type: map, expected a string at line 1 column 8`],
    ['{"path":[],"args":{}}', `${SHAPE}path: invalid type: sequence, expected a string at line 1 column 8`],
    [
      '{"path":"m:ok","args":{},"format":[1]}',
      `${SHAPE}format: invalid type: sequence, expected a string at line 1 column 34`,
    ],
    ["[]", `${SHAPE}invalid length 0, expected struct UdfPostRequest with 3 elements at line 1 column 2`],
    ['["m:ok",{}]', `${SHAPE}invalid length 2, expected struct UdfPostRequest with 3 elements at line 1 column 11`],
    ["5", `${SHAPE}invalid type: integer \`5\`, expected struct UdfPostRequest at line 1 column 1`],
    ["null", `${SHAPE}invalid type: null, expected struct UdfPostRequest at line 1 column 4`],
    ['"s"', `${SHAPE}invalid type: string "s", expected struct UdfPostRequest at line 1 column 3`],
    ['{"path":"é","x":1}', `${SHAPE}missing field \`args\` at line 1 column 19`],
  ];
  test.each(cases)("%j", (body, message) => {
    expect(() => parseJsonBody(body, UDF_POST)).toThrow(message);
  });

  test("bodies Convex accepts", () => {
    for (const body of [
      '{"path":"m:ok","args":{},"format":"json"} ',
      '{"path":"m:ok","args":{},"format":null}',
      '{"path":"m:ok", "args":{} }',
    ])
      expect(parseJsonBody<{ path: string }>(body, UDF_POST).path).toBe("m:ok");
  });
});

describe("the request", () => {
  test("another method is 405 with `allow: POST` and no body", async () => {
    const { base } = await setup();
    for (const route of ["mutation", "action", "function", "query_at_ts"]) {
      const r = await fetch(`${base}/api/${route}`);
      expect([r.status, r.headers.get("allow"), await r.text()]).toEqual([405, "POST", ""]);
    }
  });

  test("the auth header's syntax is checked before the body, a key after it", async () => {
    const { post } = await setup();
    expect(await post("query", "{nope", { "content-type": "application/json", authorization: "x" })).toEqual({
      status: 400,
      body: { code: "InvalidHeaderFailure", message: "Invalid authentication header" },
    });
    expect(
      await post("query", "{nope", { "content-type": "application/json", authorization: "Basic abcdefgh" }),
    ).toEqual({
      status: 400,
      body: { code: "InvalidAdminKey", message: "Invalid admin key" },
    });
    expect(
      (await post("query", "{nope", { "content-type": "application/json", authorization: "Bunvex nope" })).body.code,
    ).toBe("BadJsonBody");
  });
});

describe("/api/function", () => {
  const DEPLOY = {
    status: 403,
    body: {
      code: "BadDeployKey",
      message:
        "The provided deploy key was invalid for this deployment. Double check that the environment this key was generated for matches the desired deployment.",
    },
  };

  test("an admin's only: no key, a user or a system key is 403 BadDeployKey", async () => {
    const { post } = await setup();
    const body = JSON.stringify({ path: "m:ok", args: {} });
    expect(await post("function", body)).toEqual(DEPLOY);
    expect(
      await post("function", body, { "content-type": "application/json", authorization: `Bunvex ${SYSTEM}` }),
    ).toEqual(DEPLOY);
  });

  test("an admin runs public and internal functions, on the root component", async () => {
    const { post } = await setup();
    const admin = { "content-type": "application/json", authorization: `Bunvex ${KEY}` };
    expect((await post("function", JSON.stringify({ path: "m:secret", args: {} }), admin)).body).toEqual({
      status: "success",
      value: "internal",
    });
    expect(
      (await post("function", JSON.stringify({ path: "m:ok", args: {}, componentPath: "" }), admin)).body.value,
    ).toBe("ok");
    expect(await post("function", JSON.stringify({ path: "m:ok", args: {}, componentPath: "x" }), admin)).toEqual({
      status: 500,
      body: { code: "InternalServerError", message: "Your request couldn't be completed. Try again later." },
    });
  });
});
