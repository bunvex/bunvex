// A nested call's error as its caller sees it, in the caller's own realm (the app of `caller-realm-app/`), on Convex's
// backend (the oracle) and on bunvex's under both executors: a query calling a query, a mutation a query, an action a
// mutation, and the app's query, mutation and action calling its component's, the callee throwing a plain error or an
// application error with data. The caller catches it and reports `instanceof Error`, `instanceof` the application
// error class, its prototype and constructor, name, message, data, own keys and whether its stack has the caller's
// frame. Convex makes the error again in the caller's code (`performAsyncSyscall`,
// npm-packages/convex/src/server/impl/syscall.ts:28-55): `new Error(e.message)`, or the application error class with
// its data. Only decided differences are rewritten: the class's name and the functions' directory (DV-03), frame
// positions (DV-346). Local only: skipped, with a note, when Convex's backend is not there.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`caller-realm: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../caller-realm-app");
const PROCESS = { BUNVEX_FUNCTION_SANDBOX: "process", BUNVEX_FUNCTION_SANDBOX_ISOLATION: "none" };

/** Each backend's project gets the `thrower` component; bunvex's with its imports and its config file's name. */
function prepare(project: string, dir: "convex" | "bunvex") {
  const functions = join(project, dir);
  cpSync(join(APP, "thrower"), join(functions, "thrower"), { recursive: true });
  if (dir === "convex") return;
  const rewrite = (file: string) =>
    writeFileSync(
      file,
      readFileSync(file, "utf8")
        .replaceAll('"convex/server"', '"@bunvex/server"')
        .replaceAll('"convex/values"', '"@bunvex/values"')
        .replaceAll("ConvexError", "BunvexError")
        .replaceAll("/convex.config", "/bunvex.config"),
    );
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts")) {
        rewrite(p);
        if (name === "convex.config.ts") renameSync(p, join(d, "bunvex.config.ts"));
      }
    }
  };
  walk(functions);
}

let convex: Backend;
let bunvexVm: Backend;
let bunvexProcess: Backend | null = null;

// Components under `BUNVEX_FUNCTION_SANDBOX=process` come with STUDY-168 PR 7 (#822): until then the process server
// gets the app without its component, and the component cases run under `vm` only.
const PROCESS_COMPONENTS = false;
function withoutComponent(project: string, dir: "convex" | "bunvex") {
  writeFileSync(
    join(project, dir, "errors.ts"),
    readFileSync(join(project, dir, "errors.ts"), "utf8").replace(
      /\/\*\* The app's query calling its component's query\. \*\/[\s\S]*?(?=\/\*\* The app's own)/,
      "",
    ),
  );
  rmSync(join(project, dir, "convex.config.ts"), { force: true });
}

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvexVm, bunvexProcess] = await Promise.all([
    startConvex({ app: APP, prepare }),
    startBunvex({ app: APP, prepare }),
    startBunvex({ app: APP, env: PROCESS, ...(PROCESS_COMPONENTS ? { prepare } : { prepare: withoutComponent }) }),
  ]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvexVm?.stop(), bunvexProcess?.stop()]);
});

const decided = (s: string) =>
  s
    .replace(/\[Request ID: [0-9a-f]{16}\] /g, "")
    .replaceAll("ConvexError", "BunvexError")
    .replaceAll("../convex/", "../bunvex/")
    .replace(/:\d+:\d+\)/g, ":N:N)");

/** Own properties each engine gives an error (V8's runtime `__frameData`, JavaScriptCore's positions): not the app's. */
const ENGINE_KEYS = new Set(["__frameData", "line", "column", "sourceURL", "originalLine", "originalColumn"]);

type Seen = Record<string, unknown> & { instanceofError: boolean; instanceofAppError: boolean };

async function seen(b: Backend, kind: "query" | "mutation" | "action", path: string, data: boolean): Promise<Seen> {
  const { ok, body } = await b.call(kind, path, { data });
  if (!ok) throw new Error(`${path} failed: ${JSON.stringify(body)}`);
  // The stack's frames differ where bunvex already maps them its own way (STUDY-95): only printed, on request.
  const { stack, ...v } = (body as { value: Record<string, unknown> }).value;
  if (process.env.CALLER_REALM_STACKS) console.log(`--- ${b.name} ${path} ${data}\n${stack}`);
  return {
    ...v,
    constructorName: decided(String(v.constructorName)),
    name: decided(String(v.name)),
    message: decided(String(v.message)),
    ownKeys: (v.ownKeys as string[]).filter((k) => !ENGINE_KEYS.has(k)),
  } as unknown as Seen;
}

const CASES = [
  ["query → query", "query", "errors:queryToQuery", false],
  ["mutation → query", "mutation", "errors:mutationToQuery", false],
  ["action → mutation", "action", "errors:actionToMutation", false],
  ["app query → component query", "query", "errors:queryToComponent", true],
  ["app mutation → component mutation", "mutation", "errors:mutationToComponent", true],
  ["app action → component mutation", "action", "errors:actionToComponent", true],
  ["the app's own errors (baseline)", "query", "errors:ownErrors", false],
] as const;

describe.skipIf(!ready)("a nested call's error in the caller's realm, against Convex's backend", () => {
  for (const [what, kind, path, component] of CASES)
    for (const data of [false, true])
      test(`${what}, ${data ? "an application error with data" : "a plain error"}`, async () => {
        const c = await seen(convex, kind, path, data);
        // What Convex's caller sees: an error of its own realm, of the application class with data.
        expect(c.instanceofError).toBe(true);
        expect(c.instanceofAppError).toBe(data);
        expect(await seen(bunvexVm, kind, path, data)).toEqual(c);
        if (!component || PROCESS_COMPONENTS) expect(await seen(bunvexProcess!, kind, path, data)).toEqual(c);
      });
});
