// The client version check (STUDY-67 H12, DV-315). Expected answers are Convex's local backend's, probed with
// the same headers in `Convex-Client` (STUDY-67 §7), in bunvex's words: no "Convex" in the messages, and the
// deprecation headers named `x-bunvex-deprecation-*`. bunvex sets no thresholds of its own yet, so no client is
// deprecated by default (STUDY-139 P2, DV-442); the mechanism is tested with thresholds passed in.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { type ClientTypes, clientVersionCheck, clientVersionVerdict, parseSemver } from "../src/client-version.ts";
import { Functions, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

// The version bunvex's client announces: its own package's (`@bunvex/client`'s VERSION; the server may not
// import the client).
const VERSION = "0.1.0-alpha.0";
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

test("semver: the `semver` crate's reasons (Convex's answers for /api/<version>/sync)", () => {
  const cases: [string, string][] = [
    ["", "empty string, expected a semver version"],
    ["1", "unexpected end of input while parsing major version number"],
    ["1.0", "unexpected end of input while parsing minor version number"],
    ["abc", "unexpected character 'a' while parsing major version number"],
    ["%zz", "unexpected character '%' while parsing major version number"],
    ["1.x.0", "unexpected character 'x' while parsing minor version number"],
    ["1;0", "unexpected character ';' after major version number"],
    ["1.0\n", "unexpected character '\\n' after minor version number"],
    ["é", "unexpected character 'é' while parsing major version number"],
    ["01.0.0", "invalid leading zero in major version number"],
    ["18446744073709551616.0.0", "value of major version number exceeds u64::MAX"],
    ["1.0.0_x", "unexpected character '_' after patch version number"],
    ["1.0.0-", "empty identifier segment in pre-release identifier"],
    ["1.0.0-01", "invalid leading zero in pre-release identifier"],
    ["1.0.0-a..b", "empty identifier segment in pre-release identifier"],
    ["1.0.0-a.", "empty identifier segment in pre-release identifier"],
    ["1.0.0-.a", "empty identifier segment in pre-release identifier"],
    ["1.0.0-é", "empty identifier segment in pre-release identifier"],
    ["1.0.0-a_b", "unexpected character '_' after pre-release identifier"],
    ["1.0.0+", "empty identifier segment in build metadata"],
    ["1.0.0+b..c", "empty identifier segment in build metadata"],
    ["1.0.0+b_c", "unexpected character '_' after build metadata"],
  ];
  for (const [text, why] of cases) expect([text, parseSemver(text)]).toEqual([text, why]);
  for (const ok of ["18446744073709551615.0.0", "1.0.0-rc.1", "1.0.0-0.0.0", "0.0.0-a+b", "1.2.3-x-y.z", "1.0.0+01"])
    expect(typeof parseSemver(ok)).toBe("object");
});

// Thresholds as a deployment would set them, to exercise the mechanism: bunvex sets none yet (STUDY-139 P2, DV-442).
const TYPES: ClientTypes = {
  npm: {
    name: "npm",
    thresholds: { upgradeRequired: [0, 19, 1], unsupported: [0, 19, 0] },
    upgrade: "Update your npm package with `npm update`.",
  },
  python: {
    name: "python",
    thresholds: { upgradeRequired: [0, 1, 0], unsupported: [0, 0, 2] },
    upgrade: "Update your python package with `pip install --upgrade`.",
  },
};
const UNSUPPORTED = (version: string, client = "npm") =>
  `The ${client} package at version ${version} is no longer supported. Update your npm package with \`npm update\`.`;
const UPGRADE_PYTHON =
  "The python package at 0.1.0 is deprecated and will no longer be supported soon. When this version is no " +
  "longer supported, requests to the deployment will fail, so it is best to upgrade and redeploy your " +
  "application as soon as possible. Update your python package with `pip install --upgrade`.";

test("the header: a version that does not parse is refused; no client is deprecated by default (DV-442)", () => {
  const verdict = (h: string) => {
    const r = clientVersionVerdict(h, "/api/query");
    return r === null ? null : r.status === 400 ? r.code : r.headers.get("x-bunvex-deprecation-state");
  };
  for (const h of ["npm", ""]) expect([h, verdict(h)]).toEqual([h, "InvalidClientVersion"]);
  // Convex refuses these by its own thresholds (npm 0.19.1, python 0.0.2, rust 0.0.1); bunvex has none.
  const fine = [
    "npm-abc",
    "npm-0.19.1",
    "npm-0.0.0-0.0.0",
    "npm-cli-0.1.0-alpha.0",
    "python-0.0.2",
    "python-0.1.0",
    "rust-0.0.1",
    "swift-0.0.0",
    "foo-bar",
    `npm-${VERSION}`,
  ];
  for (const h of fine) expect([h, verdict(h)]).toEqual([h, null]);
  expect(clientVersionVerdict(null, "/api/0.19.1/sync")).toBeNull();
  expect(clientVersionVerdict(null, `/api/${VERSION}/sync`)).toBeNull();
  expect(clientVersionVerdict(null, "/api/1.0/sync")).toMatchObject({ status: 400, code: "InvalidClientVersion" });
});

test("the thresholds, when set: the longest semver from the right, as Convex's ClientVersion", () => {
  const verdict = (h: string) => {
    const r = clientVersionVerdict(h, "/api/query", TYPES);
    return r === null ? null : r.status === 400 ? r.code : r.headers.get("x-bunvex-deprecation-state");
  };
  for (const h of ["npm", ""]) expect([h, verdict(h)]).toEqual([h, "InvalidClientVersion"]);
  const unsupported = [
    "npm-",
    "npm-abc",
    "npm-0.19.0",
    "npm-0.19.0-alpha",
    "NPM-0.1.0",
    "npm-cli-abc",
    "python-0.0.2",
    "npm-1",
    "npm-01.0.0",
    "npm-1.0.0-01",
    "npm-1;0",
    "npm-0.0.0-0.0.0",
  ];
  for (const h of unsupported) expect([h, verdict(h)]).toEqual([h, "ClientVersionUnsupported"]);
  for (const h of ["python-0.1.0", "npm-0.19.1", "npm-0.19.1-alpha", "npm-0.19.0+b"])
    expect([h, verdict(h)]).toEqual([h, "UpgradeRequired"]);
  const fine = [
    "npm-0.19.2",
    "npm-0.19.1+b",
    "npm-0.19.2-alpha",
    "python-0.2.1",
    "rust-0.0.1",
    "npm-cli-0.1.0-alpha.0",
    "foo-bar",
    "a-b-c-1.2.3-4-5",
  ];
  for (const h of fine) expect([h, verdict(h)]).toEqual([h, null]);
  expect(clientVersionVerdict("npm-0.19.0", "/api/query", TYPES)).toMatchObject({ message: UNSUPPORTED("0.19.0") });
  expect(clientVersionVerdict("npm-cli-abc", "/api/query", TYPES)).toMatchObject({ message: UNSUPPORTED("cli-abc") });
  expect(clientVersionVerdict(null, "/api/0.19.0/sync", TYPES)).toMatchObject({ code: "ClientVersionUnsupported" });
  expect(clientVersionVerdict(null, "/api/0.19.2/sync", TYPES)).toBeNull();
  // A header with a byte Convex's `to_str` refuses counts as absent.
  expect(clientVersionVerdict("npm-é", "/api/query", TYPES)).toBeNull();
});

test("the check in front of a fetch: a refusal never reaches it; a deprecated client's answer says so", async () => {
  let reached = 0;
  const fetch = clientVersionCheck(async () => {
    reached++;
    return new Response("ok", { headers: { "access-control-allow-origin": "https://app.example" } });
  }, TYPES);
  const call = async (client: string) => {
    const r = await fetch(new Request("http://x/api/query", { headers: { "bunvex-client": client } }), null);
    return {
      status: r!.status,
      body: await r!.text(),
      state: r!.headers.get("x-bunvex-deprecation-state"),
      message: r!.headers.get("x-bunvex-deprecation-message"),
      cors: r!.headers.get("access-control-allow-origin"),
    };
  };
  expect(await call("npm-0.19.0")).toEqual({
    status: 400,
    body: JSON.stringify({ code: "ClientVersionUnsupported", message: UNSUPPORTED("0.19.0") }),
    state: "Unsupported",
    message: UNSUPPORTED("0.19.0"),
    cors: null,
  });
  expect(reached).toBe(0);
  expect(await call("python-0.1.0")).toEqual({
    status: 200,
    body: "ok",
    state: "UpgradeRequired",
    message: UPGRADE_PYTHON,
    cors: "https://app.example",
  });
  expect(reached).toBe(1);
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: "probe", instanceSecret: "4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974" },
  ).init();
  const functions = new Functions(engine).register("m", { ok: query(async () => "ok") });
  const s = createServer({ engine, functions, port: 0, sitePort: 0 });
  stops.push(s.stop);
  const api = `http://127.0.0.1:${s.server!.port}`;
  const call = async (client: string | null, url = `${api}/api/query`, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", ...extra };
    if (client !== null) headers["bunvex-client"] = client;
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ path: "m:ok", args: {} }) });
    const text = await r.text();
    return {
      status: r.status,
      body: text.startsWith("{") ? JSON.parse(text) : text,
      state: r.headers.get("x-bunvex-deprecation-state"),
      message: r.headers.get("x-bunvex-deprecation-message"),
      cors: r.headers.get("access-control-allow-origin"),
    };
  };
  return { api, site: s.siteUrl, call };
}

test("over HTTP: Convex's 400s for a version that does not parse, before every other layer (no CORS headers)", async () => {
  const { api, call } = await setup();
  const origin = { origin: "https://app.example" };
  expect(await call("npm", undefined, origin)).toEqual({
    status: 400,
    body: {
      code: "InvalidClientVersion",
      message:
        "Failed to parse client version string: 'npm'. Expected format is {client_name}-{semver}, e.g. my-esolang-client-0.0.1",
    },
    state: null,
    message: null,
    cors: null,
  });
  // Old versions Convex refuses run on bunvex (DV-442).
  for (const client of [null, `npm-${VERSION}`, "npm-0.19.1", "python-0.1.0", "swift-0.0.0"])
    expect(await call(client)).toMatchObject({ status: 200, state: null, body: { status: "success" } });
  // Any route: an unknown one, the health route, a preflight.
  expect((await call("npm", `${api}/api/nope`)).status).toBe(400);
  const health = await fetch(`${api}/instance_name`, { headers: { "bunvex-client": "npm" } });
  expect(health.status).toBe(400);
  const preflight = await fetch(`${api}/api/query`, { method: "OPTIONS", headers: { "bunvex-client": "npm" } });
  expect(preflight.status).toBe(400);
});

test("the site (HTTP actions) is checked too, as Convex's site proxy", async () => {
  const { site, call } = await setup();
  expect((await call("npm", `${site}/anything`)).body.code).toBe("InvalidClientVersion");
  expect((await call("npm-0.0.1", `${site}/anything`)).status).not.toBe(400);
});

test("the sync socket: the version in its URL when there is no header", async () => {
  const { api } = await setup();
  const get = async (version: string, headers: Record<string, string> = {}) => {
    const r = await fetch(`${api}/api/${version}/sync`, { headers });
    const text = await r.text();
    return { status: r.status, body: text.startsWith("{") ? JSON.parse(text) : text };
  };
  expect(await get("1.0")).toEqual({
    status: 400,
    body: {
      code: "InvalidClientVersion",
      message: "Failed to parse client version: unexpected end of input while parsing minor version number",
    },
  });
  expect((await get("")).body.message).toBe("Failed to parse client version: empty string, expected a semver version");
  expect((await get("%zz")).body.message).toBe(
    "Failed to parse client version: unexpected character '%' while parsing major version number",
  );
  expect((await get("%C3%A9")).body.message).toBe(
    "Failed to parse client version: unexpected character 'é' while parsing major version number",
  );
  // Past the check (not a socket request, so the upgrade itself fails).
  for (const version of ["0.19.1", "0.19.2", "%31.0.0", "%FF", VERSION])
    expect((await get(version)).body).toBe("upgrade failed");
  // The header wins over the URL.
  expect((await get("abc", { "bunvex-client": `npm-${VERSION}` })).body).toBe("upgrade failed");
  expect((await get(VERSION, { "bunvex-client": "npm" })).body.code).toBe("InvalidClientVersion");
});

test("bunvex's sync client connects (its URL carries its own version)", async () => {
  const { api } = await setup();
  const ws = new WebSocket(`${api.replace("http", "ws")}/api/${VERSION}/sync`);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  ws.close();
});
