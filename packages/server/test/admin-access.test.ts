// Admin access (STUDY-34): what each identity reaches over HTTP and sync — internal functions, `_system/*`
// functions, acting as a user — with Convex's operations and errors; check_admin_key, the job
// cancellations and /stats.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MemoryBlobStore } from "@bunvex/file-storage";
import type { v1 } from "@bunvex/protocol";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey, READ_ONLY_OPERATIONS } from "../src/admin-keys.ts";
import {
  action,
  Functions,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../src/functions.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { createServer } from "../src/server.ts";
import { add, history, syncUrl, v1Client } from "./v1-client.ts";

const SECRET = "4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974";
const NAME = "carnitas";
const cipherKey = adminKeyCipherKey(SECRET);
const KEY = issueAdminKey({ instanceName: NAME, cipherKey });
const READ_ONLY = issueAdminKey({ instanceName: NAME, cipherKey, readOnly: true });
const SYSTEM = issueAdminKey({ instanceName: NAME, cipherKey, system: true });
const OTHER = issueAdminKey({ instanceName: "tacos", cipherKey });
const actingAs = (identity: object) => Buffer.from(JSON.stringify(identity)).toString("base64");

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  const functions = new Functions(engine).register("m", {
    whoami: query(async ({ auth }) => auth.getUserIdentity()),
    secret: internalQuery(async () => "internal"),
    bump: internalMutation(async ({ db }) => db.insert("items", {})),
    act: internalAction(async () => "acted"),
    write: mutation(async ({ db }) => {
      await db.insert("items", {});
      return "wrote";
    }),
    schedule: mutation(async ({ scheduler }) => scheduler.runAfter(3_600_000, "m:write", {})),
    callsInternal: action(async ({ runQuery }) => runQuery("m:secret", {})),
  });
  const http = httpRouter();
  http.route({
    path: "/who",
    method: "GET",
    handler: httpAction(async ({ auth }) => Response.json(await auth.getUserIdentity())),
  });
  const server = createServer({
    engine,
    functions,
    port: 0,
    fileStorage: new MemoryBlobStore(),
    http,
    redactLogsToClient: false,
  });
  stops.push(server.stop);
  const api = `http://127.0.0.1:${server.server.port}`;
  const call = async (kind: string, path: string, args: object = {}, auth?: string, query = "") => {
    const r = await fetch(`${api}/api/${kind}${query}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({ path, args }),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const get = async (path: string, auth?: string) => {
    const r = await fetch(`${api}${path}`, { headers: auth ? { authorization: auth } : {} });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  return { engine, functions, api, call, get, server };
}

const NOT_FOUND = (p: string) => ({
  status: "error",
  errorMessage: expect.stringMatching(
    new RegExp(
      `^\\[Request ID: [0-9a-f]{16}\\] Server Error\\nCould not find public function for '${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'\\.\\n$`,
    ),
  ),
});
/** The error a sync client sees for a missing function (with its request id). */
/** A `_system/` query refused to a session that is not an admin's (Convex's `SystemIdentityRequired`). */
const refusedLine = expect.stringMatching(
  /^error: \[Request ID: [0-9a-f]{16}\] Server Error\nOperation query not permitted\n$/,
);
const notFoundLine = (p: string) =>
  expect.stringMatching(
    new RegExp(
      `^error: \\[Request ID: [0-9a-f]{16}\\] Server Error\\nCould not find public function for '${p}'\\.\\n$`,
    ),
  );

describe("HTTP: who reaches what", () => {
  test("internal functions: missing without a key; an admin runs them (header, ?adminKey=, type prefix)", async () => {
    const { call } = await setup();
    expect((await call("query", "m:secret")).body).toMatchObject(NOT_FOUND("m:secret"));
    expect((await call("query", "m:secret", {}, `Bunvex ${KEY}`)).body).toMatchObject({
      status: "success",
      value: "internal",
    });
    expect((await call("query", "m:secret", {}, undefined, `?adminKey=${encodeURIComponent(KEY)}`)).body).toMatchObject(
      {
        value: "internal",
      },
    );
    expect((await call("query", "m:secret", {}, `bunvex prod:${KEY}`)).body).toMatchObject({ value: "internal" });
    expect((await call("mutation", "m:bump", {}, `Bunvex ${KEY}`)).body.status).toBe("success");
    expect((await call("action", "m:act", {}, `Bunvex ${SYSTEM}`)).body).toMatchObject({ value: "acted" });
    expect((await call("action", "m:act")).body).toMatchObject(NOT_FOUND("m:act"));
  });

  test("a bad key is 401 BadAdminKey: another instance, garbage", async () => {
    const { call } = await setup();
    const bad = { code: "BadAdminKey", message: "The provided admin key was invalid for this instance" };
    for (const k of [OTHER, `${NAME}|00`, "garbage"]) {
      const r = await call("query", "m:whoami", {}, `Bunvex ${k}`);
      expect(r.status).toBe(401);
      expect(r.body).toEqual(bad);
    }
    const q = await call("query", "m:whoami", {}, undefined, "?adminKey=nope");
    expect([q.status, q.body.code]).toEqual([401, "BadAdminKey"]);
  });

  test("a read-only key: internal queries yes, internal mutations no (403 OperationNotPermitted); public mutations yes", async () => {
    const { call } = await setup();
    expect((await call("query", "m:secret", {}, `Bunvex ${READ_ONLY}`)).body).toMatchObject({ value: "internal" });
    const r = await call("mutation", "m:bump", {}, `Bunvex ${READ_ONLY}`);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({
      code: "OperationNotPermitted",
      message: "You do not have permission to perform this operation (deployment:functions:runInternalMutations).",
    });
    expect((await call("mutation", "m:write", {}, `Bunvex ${READ_ONLY}`)).body).toMatchObject({ value: "wrote" });
  });

  test("an admin is anonymous inside a function; acting as a user, it is that user", async () => {
    const { call, get } = await setup();
    expect((await call("query", "m:whoami", {}, `Bunvex ${KEY}`)).body).toMatchObject({ value: null });
    const user = { issuer: "https://issuer", subject: "u1", name: "Ada", plan: "pro" };
    const r = await call("query", "m:whoami", {}, `Bunvex ${KEY}:${actingAs(user)}`);
    expect(r.body).toMatchObject({
      status: "success",
      value: {
        tokenIdentifier: "https://issuer|u1",
        issuer: "https://issuer",
        subject: "u1",
        name: "Ada",
        plan: "pro",
      },
    });
    // tokenIdentifier alone is enough.
    expect(
      (await call("query", "m:whoami", {}, `Bunvex ${KEY}:${actingAs({ tokenIdentifier: "t" })}`)).body,
    ).toMatchObject({
      value: { tokenIdentifier: "t" },
    });
    // The user is passed on to what an action calls.
    expect((await call("action", "m:callsInternal", {}, `Bunvex ${KEY}`)).body).toMatchObject({ value: "internal" });
    // HTTP actions see the same identities.
    expect((await get("/http/who", `Bunvex ${KEY}`)).body).toBeNull();
    expect((await get("/http/who", `Bunvex ${KEY}:${actingAs(user)}`)).body).toMatchObject({ subject: "u1" });
  });

  test("acting as a user: ActAsUser required; a malformed identity is 400; never with a system key", async () => {
    const { call } = await setup();
    const user = actingAs({ issuer: "i", subject: "s" });
    const ro = await call("query", "m:whoami", {}, `Bunvex ${READ_ONLY}:${user}`);
    expect([ro.status, ro.body.message]).toEqual([
      403,
      "You do not have permission to perform this operation (deployment:functions:actAsUser).",
    ]);
    for (const bad of [
      "%%%",
      actingAs({ subject: "only" }),
      actingAs([1]),
      actingAs({ issuer: "i", subject: "s", name: 3 }),
    ]) {
      const r = await call("query", "m:whoami", {}, `Bunvex ${KEY}:${bad}`);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ code: "HeaderParseFailure", message: "Malformed Authorization header." });
    }
    expect((await call("query", "m:whoami", {}, `Bunvex ${SYSTEM}:${user}`)).status).toBe(500);
  });

  test("_system/* functions: refused without a key (SystemIdentityRequired); an admin calls them with its operations", async () => {
    const { call } = await setup();
    const anon = await call("query", "_system/frontend/listCronJobs");
    expect([anon.status, anon.body]).toEqual([
      403,
      { code: "SystemIdentityRequired", message: "Operation query not permitted" },
    ]);
    expect((await call("query", "_system/frontend/listCronJobs", {}, `Bunvex ${KEY}`)).body).toMatchObject({
      status: "success",
      value: [],
    });
    expect(
      (await call("query", "_system/frontend/fileStorageV2:numFiles", {}, `Bunvex ${READ_ONLY}`)).body,
    ).toMatchObject({ value: 0 });
    // A mutation needs WriteData.
    const ro = await call("mutation", "_system/frontend/fileStorageV2:generateUploadUrl", {}, `Bunvex ${READ_ONLY}`);
    expect([ro.status, ro.body.message]).toEqual([
      403,
      "You do not have permission to perform this operation (deployment:data:write).",
    ]);
    const ok = await call("mutation", "_system/frontend/fileStorageV2:generateUploadUrl", {}, `Bunvex ${KEY}`);
    expect(ok.body.value).toMatch(/\/api\/storage\/upload\?token=/);
    expect((await call("mutation", "_system/frontend/fileStorageV2:generateUploadUrl")).body).toEqual({
      code: "SystemIdentityRequired",
      message: "Operation mutation not permitted",
    });
  });

  test("GET /api/check_admin_key", async () => {
    const { get } = await setup();
    expect(await get("/api/check_admin_key", `Bunvex ${KEY}`)).toEqual({
      status: 200,
      body: { success: true, allowedOps: [], isReadOnly: false },
    });
    expect(await get("/api/check_admin_key", `Bunvex ${READ_ONLY}`)).toEqual({
      status: 200,
      body: { success: true, allowedOps: [...READ_ONLY_OPERATIONS], isReadOnly: true },
    });
    const deploy = {
      code: "BadDeployKey",
      message: `The provided deploy key was invalid for deployment '${NAME}'. Double check that the environment this key was generated for matches the desired deployment.`,
    };
    expect(await get("/api/check_admin_key")).toEqual({ status: 403, body: deploy });
    expect(await get("/api/check_admin_key", `Bunvex ${SYSTEM}`)).toEqual({ status: 403, body: deploy });
    expect((await get("/api/check_admin_key", `Bunvex ${OTHER}`)).status).toBe(401);
  });

  test("POST /api/cancel_job and /api/cancel_all_jobs need WriteData", async () => {
    const { call, api, functions } = await setup();
    const id = (await call("mutation", "m:schedule")).body.value as string;
    await call("mutation", "m:schedule");
    const post = (path: string, body: object, auth?: string) =>
      fetch(`${api}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
        body: JSON.stringify(body),
      });
    expect((await post("/api/cancel_job", { id })).status).toBe(403);
    const ro = await post("/api/cancel_job", { id }, `Bunvex ${READ_ONLY}`);
    expect([ro.status, ((await ro.json()) as { code: string }).code]).toEqual([403, "OperationNotPermitted"]);
    const r = await post("/api/cancel_job", { id }, `Bunvex ${KEY}`);
    expect([r.status, await r.text()]).toEqual([200, ""]);
    const pending = async () =>
      (
        (await functions.runSystemQuery("_system/frontend/paginatedScheduledJobs", {
          paginationOpts: { numItems: 10, cursor: null },
        })) as { page: unknown[] }
      ).page.length;
    expect(await pending()).toBe(1);
    expect((await post("/api/cancel_all_jobs", {}, `Bunvex ${KEY}`)).status).toBe(200);
    expect(await pending()).toBe(0);
  });

  test("/stats needs an admin key with ViewMetrics (DV-162)", async () => {
    const { get } = await setup();
    expect((await get("/stats")).status).toBe(403);
    const r = await get("/stats", `Bunvex ${READ_ONLY}`);
    expect(r.status).toBe(200);
    expect(typeof r.body.ts).toBe("number");
  });

  test("GET /instance_name needs nothing", async () => {
    const { api } = await setup();
    expect(await (await fetch(`${api}/instance_name`)).text()).toBe(NAME);
  });
});

describe("sync: Authenticate Admin", () => {
  const authenticate = (value: string, impersonating?: unknown): v1.ClientMessage =>
    ({
      type: "Authenticate",
      tokenType: "Admin",
      value,
      baseVersion: 0,
      ...(impersonating === undefined ? {} : { impersonating }),
    }) as v1.ClientMessage;

  test("a bad key: AuthError (no update attempted), then close", async () => {
    const { server } = await setup();
    const c = await v1Client(syncUrl(server.server.port));
    c.send(authenticate(OTHER));
    const e = await c.until(() => c.got.find((m) => m.type === "AuthError"));
    expect(e).toMatchObject({
      error: "The provided admin key was invalid for this instance",
      authUpdateAttempted: false,
    });
    await c.closed;
  });

  test("an admin subscribes to internal and system queries; acting as a user, it is that user", async () => {
    const { server } = await setup();
    const c = await v1Client(syncUrl(server.server.port));
    c.send(authenticate(KEY));
    c.modify([add(1, "m:secret"), add(2, "_system/frontend/listCronJobs"), add(3, "m:whoami")]);
    await c.until(() => history(c.transitions(), 1).length && history(c.transitions(), 2).length);
    expect(history(c.transitions(), 1)).toEqual(["internal"]);
    expect(history(c.transitions(), 2)).toEqual([[]]);
    expect(history(c.transitions(), 3)).toEqual([null]);
    const u = await v1Client(syncUrl(server.server.port));
    u.send(authenticate(KEY, { issuer: "i", subject: "s" }));
    u.modify([add(1, "m:whoami")]);
    await u.until(() => history(u.transitions(), 1).length);
    expect(history(u.transitions(), 1)).toEqual([{ tokenIdentifier: "i|s", issuer: "i", subject: "s" }]);
  });

  test("a session without a key never gets an admin's run of an internal or system query", async () => {
    const { server } = await setup();
    const admin = await v1Client(syncUrl(server.server.port));
    admin.send(authenticate(KEY));
    admin.modify([add(1, "m:secret"), add(2, "_system/frontend/listCronJobs")]);
    await admin.until(() => history(admin.transitions(), 2).length);
    const anon = await v1Client(syncUrl(server.server.port));
    anon.modify([add(1, "m:secret"), add(2, "_system/frontend/listCronJobs")]);
    await anon.until(() => history(anon.transitions(), 2).length);
    expect(history(anon.transitions(), 1)).toEqual([notFoundLine("m:secret")]);
    expect(history(anon.transitions(), 2)).toEqual([refusedLine]);
    // And the other way round: an admin after a denied session still gets the result.
    const admin2 = await v1Client(syncUrl(server.server.port));
    admin2.send(authenticate(KEY));
    admin2.modify([add(1, "m:secret")]);
    await admin2.until(() => history(admin2.transitions(), 1).length);
    expect(history(admin2.transitions(), 1)).toEqual(["internal"]);
    // A read-only admin acting as a user may not: its run fails, the full admin's is not handed to it.
    const ro = await v1Client(syncUrl(server.server.port));
    ro.send(authenticate(READ_ONLY, { issuer: "i", subject: "s" }));
    ro.modify([add(1, "m:secret")]);
    await ro.until(() => history(ro.transitions(), 1).length);
    expect(history(ro.transitions(), 1)).toEqual([
      expect.stringContaining("You do not have permission to perform this operation (deployment:functions:actAsUser)."),
    ]);
  });

  test("an admin after a session that was denied the same query still runs it (no denied run is reused)", async () => {
    const { server } = await setup();
    const anon = await v1Client(syncUrl(server.server.port));
    anon.modify([add(1, "m:secret"), add(2, "_system/frontend/listCronJobs")]);
    await anon.until(() => history(anon.transitions(), 2).length);
    expect(history(anon.transitions(), 1)).toEqual([notFoundLine("m:secret")]);
    const admin = await v1Client(syncUrl(server.server.port));
    admin.send(authenticate(KEY));
    admin.modify([add(1, "m:secret"), add(2, "_system/frontend/listCronJobs")]);
    await admin.until(() => history(admin.transitions(), 2).length);
    expect(history(admin.transitions(), 1)).toEqual(["internal"]);
    expect(history(admin.transitions(), 2)).toEqual([[]]);
  });

  test("a session denied a query, then authenticated as admin on the same socket, now runs it", async () => {
    const { server } = await setup();
    const c = await v1Client(syncUrl(server.server.port));
    c.modify([add(1, "m:secret")]);
    await c.until(() => history(c.transitions(), 1).length);
    expect(history(c.transitions(), 1)).toEqual([notFoundLine("m:secret")]);
    c.send(authenticate(KEY));
    await c.until(() => history(c.transitions(), 1).length === 2);
    expect(history(c.transitions(), 1)[1]).toBe("internal");
  });

  test("an admin's mutation over sync reaches internal mutations", async () => {
    const { server } = await setup();
    const c = await v1Client(syncUrl(server.server.port));
    c.send(authenticate(KEY));
    c.mutate(1, "m:bump");
    const r = await c.until(() => c.responses()[0]);
    expect(r.success).toBe(true);
    const anon = await v1Client(syncUrl(server.server.port));
    anon.mutate(1, "m:bump");
    const a = await anon.until(() => anon.responses()[0]);
    expect(a.success).toBe(false);
    expect(String((a as { result: unknown }).result)).toContain("Could not find public function for 'm:bump'.");
  });
});
