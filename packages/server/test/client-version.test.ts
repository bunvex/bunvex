// The client version check (STUDY-67 H12, DV-315). Expected answers are Convex's local backend's, probed with
// the same headers in `Convex-Client` (STUDY-67 §7), in bunvex's words: no "Convex" in the messages, and the
// deprecation headers named `x-bunvex-deprecation-*`.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { clientVersionVerdict, parseSemver } from "../src/client-version.ts";
import { Functions, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

// The version bunvex's clients announce (`@bunvex/client`'s VERSION; the server may not import the client).
const VERSION = "1.46.0";
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

const UNSUPPORTED_NPM = (version: string, client = "npm") =>
  `The ${client} package at version ${version} is no longer supported. Update your npm package with \`npm update\`.`;
const UPGRADE_PYTHON =
  "The python package at 0.1.0 is deprecated and will no longer be supported soon. When this version is no " +
  "longer supported, requests to the deployment will fail, so it is best to upgrade and redeploy your " +
  "application as soon as possible. Update your python package with `pip install --upgrade`.";

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

test("the header: the longest semver from the right; thresholds as Convex's deprecation.json", () => {
  const verdict = (h: string) => {
    const r = clientVersionVerdict(h, "/api/query");
    return r === null ? null : r.status === 400 ? r.code : r.headers.get("x-bunvex-deprecation-state");
  };
  for (const h of ["npm", ""]) expect([h, verdict(h)]).toEqual([h, "InvalidClientVersion"]);
  const unsupported = [
    "npm-",
    "npm-abc",
    "npm-0.19.1",
    "npm-0.19.1-alpha",
    "npm-cli-0.1.0-alpha.0",
    "NPM-0.1.0",
    "npm-cli-abc",
    "python-0.0.2",
    "rust-0.0.1",
    "actions-0.1.0",
    "npm-1",
    "npm-01.0.0",
    "npm-1.0.0-01",
    "npm-1;0",
    "npm-0.0.0-0.0.0",
  ];
  for (const h of unsupported) expect([h, verdict(h)]).toEqual([h, "ClientVersionUnsupported"]);
  expect(verdict("python-0.1.0")).toBe("UpgradeRequired");
  const fine = [
    "npm-0.19.2",
    "npm-0.19.1+b",
    "npm-0.19.2-alpha",
    "python-0.2.1",
    "rust-0.0.2",
    "swift-0.0.0",
    "foo-bar",
    "npm-1.0.0-rc.1",
    "dashboard-0.0.0",
    "a-b-c-1.2.3-4-5",
    // Convex reads `python-convex` as python (refused at 0.0.1); rule 5 keeps the name out (DV-315).
    "python-convex-0.0.1",
  ];
  for (const h of fine) expect([h, verdict(h)]).toEqual([h, null]);
  // bunvex's own clients: the HTTP client, the sync client and the CLI announce the version they follow.
  expect(clientVersionVerdict(`npm-${VERSION}`, "/api/query")).toBeNull();
  expect(clientVersionVerdict(`npm-cli-${VERSION}`, "/api/stream_function_logs")).toBeNull();
  expect(clientVersionVerdict(null, `/api/${VERSION}/sync`)).toBeNull();
  // A header with a byte Convex's `to_str` refuses counts as absent.
  expect(clientVersionVerdict("npm-é", "/api/query")).toBeNull();
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

test("over HTTP: Convex's 400s, before every other layer (no CORS headers), and its deprecation headers", async () => {
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
  expect(await call("npm-0.19.1", undefined, origin)).toEqual({
    status: 400,
    body: { code: "ClientVersionUnsupported", message: UNSUPPORTED_NPM("0.19.1") },
    state: "Unsupported",
    message: UNSUPPORTED_NPM("0.19.1"),
    cors: null,
  });
  expect((await call("npm-cli-abc")).body.message).toBe(UNSUPPORTED_NPM("cli-abc"));
  // A deprecated client runs, and the answer says so.
  expect(await call("python-0.1.0", undefined, origin)).toEqual({
    status: 200,
    body: { status: "success", value: "ok" },
    state: "UpgradeRequired",
    message: UPGRADE_PYTHON,
    cors: "https://app.example",
  });
  for (const client of [null, `npm-${VERSION}`, "swift-0.0.0"])
    expect(await call(client)).toMatchObject({ status: 200, state: null, body: { status: "success" } });
  // Any route: an unknown one, the health route, a preflight.
  expect((await call("npm-abc", `${api}/api/nope`)).status).toBe(400);
  const health = await fetch(`${api}/instance_name`, { headers: { "bunvex-client": "npm-abc" } });
  expect(health.status).toBe(400);
  const preflight = await fetch(`${api}/api/query`, { method: "OPTIONS", headers: { "bunvex-client": "npm" } });
  expect(preflight.status).toBe(400);
});

test("the site (HTTP actions) is checked too, as Convex's site proxy", async () => {
  const { site, call } = await setup();
  expect((await call("npm-0.0.1", `${site}/anything`)).body.code).toBe("ClientVersionUnsupported");
  expect((await call("npm", `${site}/anything`)).body.code).toBe("InvalidClientVersion");
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
  expect(await get("0.19.1")).toEqual({
    status: 400,
    body: { code: "ClientVersionUnsupported", message: UNSUPPORTED_NPM("0.19.1") },
  });
  // Past the check (not a socket request, so the upgrade itself fails).
  for (const version of ["0.19.2", "%31.0.0", "%FF", VERSION]) expect((await get(version)).body).toBe("upgrade failed");
  // The header wins over the URL.
  expect((await get("abc", { "bunvex-client": `npm-${VERSION}` })).body).toBe("upgrade failed");
  expect((await get(VERSION, { "bunvex-client": "npm-0.1.0" })).body.code).toBe("ClientVersionUnsupported");
});

test("bunvex's sync client connects (its URL carries the version it follows)", async () => {
  const { api } = await setup();
  const ws = new WebSocket(`${api.replace("http", "ws")}/api/${VERSION}/sync`);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  ws.close();
});
