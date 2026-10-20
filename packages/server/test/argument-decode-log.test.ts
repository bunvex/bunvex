// A call whose arguments do not decode into values (a field named with `$`) is a failed run of the function in the
// function log, as in Convex: `ValidatedPathAndArgs` (crates/udf/src/validation.rs) turns `parse_udf_args`'s error
// into the function's outcome, which `log_query`, `log_mutation` and `log_action` record. The path is resolved
// first, so a missing function is "Could not find public function" whatever its arguments.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { action, Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { add, syncUrl, v1Client } from "./v1-client.ts";

const SECRET = "4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974";
const NAME = "carnitas";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

async function setup() {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false }), {
    instanceName: NAME,
    instanceSecret: SECRET,
  }).init();
  const functions = new Functions(engine).register("m", {
    q: query({ args: { s: v.any() }, handler: async (_c, { s }) => s }),
    mu: mutation({ args: { s: v.any() }, handler: async (_c, { s }) => s }),
    a: action({ args: { s: v.any() }, handler: async (_c, { s }) => s }),
  });
  const s = createServer({ engine, functions, port: 0, sitePort: null, redactLogsToClient: false });
  stops.push(s.stop);
  const api = `http://127.0.0.1:${s.server!.port}`;
  const call = async (route: string, path: string, args: unknown) => {
    const r = await fetch(`${api}/api/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    return ((await r.json()) as { errorMessage?: string }).errorMessage?.replace(/^\[Request ID: [0-9a-f]+\] /, "");
  };
  let cursor = 0;
  /** The completions logged since the last call: `[udfType, identifier, error]`. */
  const completions = async (want: number) => {
    const seen: [string, string, string][] = [];
    for (let i = 0; i < 100 && seen.length < want; i++) {
      const r = await fetch(`${api}/api/stream_function_logs?cursor=${cursor}`, {
        headers: { authorization: `Bunvex ${KEY}` },
      });
      const body = (await r.json()) as {
        entries: { kind: string; udfType?: string; identifier?: string; error?: string | null }[];
        newCursor: number;
      };
      for (const e of body.entries)
        if (e.kind === "Completion") seen.push([e.udfType!, e.identifier!, String(e.error ?? "")]);
      cursor = body.newCursor;
      if (seen.length < want) await Bun.sleep(20);
    }
    return seen;
  };
  return { call, completions, port: s.server!.port };
}

const reserved = (path: string) => `Invalid arguments for ${path}: Field name $x starts with '$', which is reserved.`;

test("arguments that do not decode: the call is a failed run in the function log, each kind", async () => {
  const { call, completions } = await setup();
  for (const [route, fn, udfType] of [
    ["query", "m:q", "Query"],
    ["mutation", "m:mu", "Mutation"],
    ["action", "m:a", "Action"],
  ] as const) {
    expect(await call(route, fn, { s: { $x: 1 } })).toBe(`Server Error\n${reserved(`m.js:${fn.slice(2)}`)}\n`);
    const logged = await completions(1);
    expect(logged).toHaveLength(1);
    expect(logged[0]!.slice(0, 2)).toEqual([udfType, fn]);
    expect(logged[0]![2]).toContain(reserved(`m.js:${fn.slice(2)}`));
  }
});

test("a missing function with arguments that do not decode: not found, as Convex resolves the path first", async () => {
  const { call, completions } = await setup();
  expect(await call("mutation", "m:nope", { $x: 1 })).toBe(
    "Server Error\nCould not find public function for 'm:nope'.\n",
  );
  const logged = await completions(1);
  expect(logged.map(([t, id]) => [t, id])).toEqual([["Mutation", "m:nope"]]);
});

test("over the sync protocol too: a mutation, a query and a missing function", async () => {
  const { completions, port } = await setup();
  const c = await v1Client(syncUrl(port));
  stops.push(() => c.ws.close());
  c.mutate(1, "m:mu", { s: { $x: 1 } });
  c.mutate(2, "m:nope", { $x: 1 });
  const [r1, r2] = await c.until(() => c.responses().length >= 2 && c.responses());
  expect((r1 as { result: string }).result).toContain(reserved("m.js:mu"));
  expect((r2 as { result: string }).result).toContain("Could not find public function for 'm:nope'.");
  c.modify([add(0, "m:q", { s: { $x: 1 } })]);
  const t = await c.until(() => c.transitions().find((x) => x.modifications.some((m) => m.type === "QueryFailed")));
  const failed = t.modifications.find((m) => m.type === "QueryFailed") as { errorMessage: string };
  expect(failed.errorMessage).toContain(reserved("m.js:q"));
  expect((await completions(3)).map(([t, id]) => [t, id])).toEqual([
    ["Mutation", "m:mu"],
    ["Mutation", "m:nope"],
    ["Query", "m:q"],
  ]);
});
