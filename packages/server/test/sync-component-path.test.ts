// A sync request's `componentPath` (STUDY-62 K8), as Convex's `parse_admin_component_path`: the root ("" or
// none) runs as usual; a non-root component may be called directly only by an admin, anyone else ends the
// session; bunvex has no components, so an admin's call fails as Convex's `ComponentPathNotFound`.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { action, Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { syncUrl, v1Client } from "./v1-client.ts";

const SECRET = "ab".repeat(32);
const NAME = "component-path-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), memberId: 6 });

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
    one: query(() => 1),
    put: mutation(({ db }) => db.insert("items", {})),
    act: action(() => "done"),
  });
  const s = createServer({ engine, functions, port: 0 });
  stops.push(() => s.stop());
  const c = await v1Client(syncUrl(s.server.port));
  stops.push(() => c.ws.close());
  return c;
}

const addIn = (queryId: number, componentPath: string) => ({
  type: "Add" as const,
  queryId,
  udfPath: "m:one",
  args: [{}],
  componentPath,
});

test("the root component path runs as usual", async () => {
  const c = await setup();
  c.modify([addIn(1, "")]);
  const t = await c.transition(0);
  expect(t.modifications).toMatchObject([{ type: "QueryUpdated", queryId: 1, value: 1 }]);
});

test("a client that is not an admin ends the session (query, mutation, action)", async () => {
  for (const send of [
    (c: Awaited<ReturnType<typeof setup>>) => c.modify([addIn(1, "rl")]),
    (c: Awaited<ReturnType<typeof setup>>) =>
      c.send({ type: "Mutation", requestId: 0, udfPath: "m:put", args: [{}], componentPath: "rl" }),
    (c: Awaited<ReturnType<typeof setup>>) =>
      c.send({ type: "Action", requestId: 0, udfPath: "m:act", args: [{}], componentPath: "rl" }),
  ]) {
    const c = await setup();
    send(c);
    const closed = await c.closed;
    expect(closed.reason).toBe("InternalServerError");
  }
});

test("an admin gets Convex's ComponentPathNotFound: bunvex has no components", async () => {
  const c = await setup();
  c.send({ type: "Authenticate", baseVersion: 0, tokenType: "Admin", value: KEY });
  c.modify([addIn(1, "rl")]);
  const t = await c.until(() => c.transitions().find((x) => x.modifications.some((m) => m.type === "QueryFailed")));
  const failed = t.modifications.find((m) => m.type === "QueryFailed") as { errorMessage: string };
  expect(failed.errorMessage).toContain("Component path 'rl' not found");
  c.send({ type: "Mutation", requestId: 0, udfPath: "m:put", args: [{}], componentPath: "rl" });
  c.send({ type: "Action", requestId: 1, udfPath: "m:act", args: [{}], componentPath: "rl" });
  await c.until(() => c.got.filter((m) => m.type === "MutationResponse" || m.type === "ActionResponse").length === 2);
  for (const r of c.got.filter((m) => m.type === "MutationResponse" || m.type === "ActionResponse") as {
    success: boolean;
    result: string;
  }[]) {
    expect(r.success).toBe(false);
    expect(r.result).toContain("Component path 'rl' not found");
  }
  // The root function of that name did not run.
  c.modify([{ type: "Add", queryId: 2, udfPath: "m:one", args: [{}] }]);
  await c.until(() => c.transitions().some((x) => x.modifications.some((m) => m.type === "QueryUpdated")));
});
