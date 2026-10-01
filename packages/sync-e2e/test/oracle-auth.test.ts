// The protocol oracle for authentication (STUDY-27 §1.5): the official client's `setAuth` against bunvex.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { createServer, Functions, mutation, query } from "@bunvex/server";
import { v } from "@bunvex/values";
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";
import { until } from "./harness.ts";
import { startIssuer } from "./issuer.ts";

const api = anyApi;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function setup() {
  const issuer = await startIssuer({ cacheControl: "max-age=600" });
  cleanup.push(issuer.stop);
  const engine = await new Engine(
    defineSchema({ notes: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("notes", {
    whoami: query(async ({ auth }) => (await auth.getUserIdentity())?.subject ?? null),
    add: mutation(async ({ db, auth }) => {
      const me = await auth.getUserIdentity();
      if (!me) throw new Error("not signed in");
      await db.insert("notes", { by: me.subject });
      return me.subject;
    }),
  });
  const server = createServer({
    engine,
    functions,
    port: 0,
    redactLogsToClient: false,
    auth: { providers: [{ domain: issuer.url, applicationID: "app" }] },
  });
  cleanup.push(server.stop);
  const c = new ConvexClient(`http://127.0.0.1:${server.server.port}`, {
    skipConvexDeploymentUrlCheck: true,
    logger: false,
  });
  cleanup.push(() => c.close());
  return { issuer, c };
}

describe("the official client's setAuth against bunvex", () => {
  test("signing in re-runs queries as the user, mutations run as them, and a refused token signs out", async () => {
    const { issuer, c } = await setup();
    const sub = c.onUpdate(api.notes.whoami, {}, () => {});
    await until(() => sub.getCurrentValue() === null, "anonymous result");
    const changes: boolean[] = [];
    c.setAuth(
      async () => issuer.sign({ sub: "ada" }),
      (isAuthenticated) => changes.push(isAuthenticated),
    );
    await until(() => sub.getCurrentValue() === "ada", "signed-in result");
    await until(() => changes.length > 0, "auth confirmed");
    expect(changes).toEqual([true]);
    expect(await c.mutation(api.notes.add, {})).toBe("ada");

    // A token the server refuses: the client retries with a fresh one, then gives up and signs out.
    c.setAuth(
      async () => issuer.sign({ aud: "other" }),
      (isAuthenticated) => changes.push(isAuthenticated),
    );
    await until(() => changes.at(-1) === false, "signed out");
    await until(() => sub.getCurrentValue() === null, "anonymous again");
  });
});
