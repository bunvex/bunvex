// An error `log.audit` throws into pushed code (STUDY-171 §10): a key starting with "$", an unknown variable, an
// action's call. Convex makes it in the app's bundle (npm-packages/convex/src/server/impl/audit_logging.ts), so the
// app sees its own frames; bunvex's `log` is the server's, seen through the context's wrapper as the engine's
// errors are (STUDY-150): the frames of the app's call, never the server's.
import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { Functions } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SERVER = JSON.stringify(["bunvex", "server"].join("/"));
const REPO = resolve(import.meta.dir, "../../..");
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

/** A server's frame or path, anywhere in a text. */
const leaks = (t: string) =>
  t.includes(REPO) || /packages\/(core|server|values)\/|bunvex-runtime:|bunvex:\/v\d|\(node:|\(native/.test(t);

const CASES = `{
  dollar: async () => { await log.audit({ ok: { $bad: 1 } }); },
  unknownVar: async () => { await log.audit({ v: Symbol("mine") }); },
  fine: async () => { await log.audit({ a: 1, at: log.vars.now }); },
}`;

async function deployment() {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  const s = createServer({
    engine,
    functions: new Functions(engine),
    port: 0,
    deployable: true,
    moduleStorage: new MemoryBlobStore(),
  });
  stops.push(() => s.shutdown());
  await s.deployCode([
    {
      path: "m.js",
      environment: "isolate",
      source: `import { action, log, mutation, query } from ${SERVER};
const cases = ${CASES};
export const uncaught = mutation(async (_ctx, { c }) => { await cases[c](); return log.vars.now === log.vars.now; });
export const caught = query(async (_ctx, { c }) => {
  try { await cases[c](); } catch (e) { return { message: e.message, stack: String(e.stack) }; }
});
export const inAction = action(async () => {
  try { await log.audit({ a: 1 }); } catch (e) { return { message: e.message, stack: String(e.stack) }; }
});`,
    },
  ]);
  return async (kind: string, path: string, args: object) =>
    (await (
      await fetch(`http://127.0.0.1:${s.server.port}/api/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args, format: "json" }),
      })
    ).json()) as { status: string; value?: { message: string; stack: string }; errorMessage?: string };
}

test("uncaught: the message, then the frames of the app's call alone", async () => {
  const call = await deployment();
  const dollar = await call("mutation", "m:uncaught", { c: "dollar" });
  expect(dollar.errorMessage).toMatch(
    /^\[Request ID: [0-9a-f]{16}\] Server Error\nUncaught Error: Audit log body keys must not start with "\$": "\$bad"\n {4}at <anonymous> \(m\.js:3:\d+\)\n {4}at <anonymous> \(m\.js:7:\d+\)\n$/,
  );
  const unknown = await call("mutation", "m:uncaught", { c: "unknownVar" });
  expect(unknown.errorMessage).toMatch(
    /Uncaught Error: Unknown audit var symbol: Symbol\(mine\)\.\n {4}at <anonymous> \(m\.js:4:/,
  );
  expect(leaks(dollar.errorMessage!) || leaks(unknown.errorMessage!)).toBe(false);
  // `log.vars` reads as itself through the wrapper.
  expect(await call("mutation", "m:uncaught", { c: "fine" })).toMatchObject({ status: "success", value: true });
});

test("caught: `error.stack` is the app's frames alone, in a query and in an action", async () => {
  const call = await deployment();
  const q = (await call("query", "m:caught", { c: "dollar" })).value!;
  expect(q.stack).toMatch(/^ {4}at <anonymous> \(m\.js:3:\d+\)\n {4}at <anonymous> \(m\.js:9:\d+\)$/);
  const a = (await call("action", "m:inAction", {})).value!;
  expect(a.message).toBe("Audit logging is not yet supported in actions");
  expect(a.stack).toMatch(/^ {4}at <anonymous> \(m\.js:12:\d+\)$/);
  expect(leaks(q.stack) || leaks(a.stack)).toBe(false);
});
