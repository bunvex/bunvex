// `ctx.auth` over HTTP and the identity-aware query cache (STUDY-27 §1.2–§1.4, B13).
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { action, Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { startIssuer } from "./issuer.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

async function setup() {
  const issuer = await startIssuer();
  stops.push(issuer.stop);
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    whoami: query(async ({ auth }) => (await auth.getUserIdentity())?.subject ?? null),
    public: query(async ({ db }) => (await db.query("items").collect()).length),
    mine: mutation(async ({ db, auth }) => {
      const me = await auth.getUserIdentity();
      return db.insert("items", { owner: me?.tokenIdentifier ?? null });
    }),
    viaAction: action(async (ctx) => ({
      direct: (await ctx.auth.getUserIdentity())?.subject ?? null,
      fromQuery: await ctx.runQuery("m:whoami", {}),
    })),
  });
  const { server, stop } = createServer({
    engine,
    functions,
    port: 0,
    redactLogsToClient: false,
    auth: { providers: [{ domain: issuer.url, applicationID: "app" }] },
  });
  stops.push(stop);
  const call = async (kind: string, path: string, token?: string | null, header?: string) => {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (header) headers.authorization = header;
    const r = await fetch(`http://127.0.0.1:${server.port}/api/${kind}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path, args: {} }),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { issuer, engine, call };
}

describe("ctx.auth over HTTP", () => {
  test("no token: null; a valid Bearer token: its identity, in queries, mutations and actions", async () => {
    const { issuer, call } = await setup();
    expect((await call("query", "m:whoami")).body).toEqual({ status: "success", value: null });
    const token = await issuer.sign({ sub: "ada" });
    expect((await call("query", "m:whoami", token)).body.value).toBe("ada");
    expect((await call("mutation", "m:mine", token)).body.status).toBe("success");
    expect((await call("action", "m:viaAction", token)).body.value).toEqual({ direct: "ada", fromQuery: "ada" });
  });

  test("a bad token is a 401 with Convex's code; malformed headers are 400s", async () => {
    const { issuer, call } = await setup();
    const expired = await issuer.sign({ exp: Math.floor(Date.now() / 1000) - 10 });
    expect(await call("query", "m:whoami", expired)).toEqual({
      status: 401,
      body: {
        code: "Unauthenticated",
        message:
          "Could not verify OIDC token claim. Check that the token signature is valid and the token hasn't expired.",
      },
    });
    expect((await call("query", "m:whoami", await issuer.sign({ aud: "other" }))).body.code).toBe("NoAuthProvider");
    expect(await call("query", "m:whoami", null, "Basic abcdef")).toEqual({
      status: 400,
      body: { code: "InvalidAdminKey", message: "Invalid admin key" },
    });
    expect((await call("query", "m:whoami", null, "x")).status).toBe(400);
    expect((await call("query", "m:whoami", null, "Bunvex some-admin-key")).status).toBe(401);
  });

  test("an invalid auth config fails at start", async () => {
    const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
    expect(() =>
      createServer({
        engine,
        functions: new Functions(engine),
        port: 0,
        auth: { providers: [{ domain: "a.com", applicationId: "x" } as never] },
      }),
    ).toThrow("must have applicationID property spelled lowercase");
  });
});

describe("the query cache keeps users apart (B13)", () => {
  test("a query that reads the identity is cached per user; one that does not is shared", async () => {
    const { issuer, engine, call } = await setup();
    const ada = await issuer.sign({ sub: "ada" });
    const bob = await issuer.sign({ sub: "bob" });
    const hits = () => engine.stats.cacheHits;

    expect((await call("query", "m:whoami", ada)).body.value).toBe("ada");
    expect((await call("query", "m:whoami", bob)).body.value).toBe("bob"); // not Ada's cached result
    expect((await call("query", "m:whoami")).body.value).toBe(null);
    const before = hits();
    expect((await call("query", "m:whoami", await issuer.sign({ sub: "ada", jti: "refreshed" }))).body.value).toBe(
      "ada",
    );
    expect(hits()).toBe(before + 1); // a refreshed token with the same claims hits Ada's entry

    await call("query", "m:public", ada);
    const shared = hits();
    await call("query", "m:public", bob);
    await call("query", "m:public");
    expect(hits()).toBe(shared + 2); // read no identity: one entry for everyone
  });
});
