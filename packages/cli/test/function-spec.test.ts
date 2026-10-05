// `bunvex function-spec` end to end, as `npx convex function-spec`: the deployment's URL, every function's
// kind, visibility and validators (in their JSON form), the HTTP routes; printed, or written with `--file`.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import {
  adminKeyCipherKey,
  createServer,
  Functions,
  httpAction,
  httpRouter,
  internalMutation,
  issueAdminKey,
  query,
} from "@bunvex/server";
import { v } from "@bunvex/values";
import { functionSpecCommand } from "../src/function-spec.ts";
import type { Io } from "../src/io.ts";

const SECRET = "7c".repeat(32);
const NAME = "cli-spec";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("bunvex function-spec: the URL, the functions with their validators, the HTTP routes; --file", async () => {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false }), {
    instanceName: NAME,
    instanceSecret: SECRET,
  }).init();
  const functions = new Functions(engine).register("messages", {
    list: query({ args: { n: v.int64() }, returns: v.array(v.string()), handler: async () => [] }),
    clear: internalMutation(async () => {}),
  });
  const http = httpRouter();
  http.route({ path: "/hook", method: "POST", handler: httpAction(async () => new Response("ok")) });
  http.route({ pathPrefix: "/files/", method: "GET", handler: httpAction(async () => new Response("ok")) });
  const s = createServer({ engine, functions, http, port: 0, exportStorage: null, fileStorage: null });
  stops.push(() => s.shutdown());
  const dir = mkdtempSync(join(tmpdir(), "bunvex-cli-spec-"));
  dirs.push(dir);
  const run = async (...args: string[]) => {
    const out: string[] = [];
    const it: Io = {
      env: { BUNVEX_SELF_HOSTED_URL: `http://127.0.0.1:${s.server.port}`, BUNVEX_SELF_HOSTED_ADMIN_KEY: KEY },
      cwd: dir,
      out: (l) => out.push(l),
      err: () => {},
    };
    return { code: await functionSpecCommand(args, it, { now: () => 1234 }), out: out.join("\n") };
  };
  const printed = await run();
  expect(printed.code).toBe(0);
  const spec = JSON.parse(printed.out) as { url: string; functions: Record<string, unknown>[] };
  expect(printed.out).toStartWith('{\n  "url": ');
  expect(spec.url).toBe(`http://127.0.0.1:${s.server.port}`);
  expect(spec.functions).toEqual([
    {
      identifier: "messages.js:list",
      functionType: "Query",
      visibility: { kind: "public" },
      args: { type: "object", value: { n: { fieldType: { type: "bigint" }, optional: false } } },
      returns: { type: "array", value: { type: "string" } },
    },
    {
      identifier: "messages.js:clear",
      functionType: "Mutation",
      visibility: { kind: "internal" },
      args: { type: "any" },
      returns: null,
    },
    { functionType: "HttpAction", method: "POST", path: "/hook" },
    { functionType: "HttpAction", method: "GET", path: "/files/*" },
  ]);
  const toFile = await run("--file");
  expect(toFile.out).toBe("Wrote function spec to function_spec_1234.json");
  expect(JSON.parse(readFileSync(join(dir, "function_spec_1234.json"), "utf8"))).toEqual(spec);
  expect((await run("--bogus")).code).toBe(2);
});
