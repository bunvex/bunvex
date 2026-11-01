// A call, a schedule or a handle naming a function that is not there, or one of another kind (STUDY-188 §X21), on
// Convex's backend (the oracle) and on bunvex's: from a V8 action, a "use node" action and a mutation of
// `run-missing-app/`, each target named by a path (a missing module, a missing export, an internal function, the wrong
// kind) or through the `cmp` component (a missing export, an internal one, a missing child). The error left uncaught
// (what the client sees) and caught (its name, message, class and whether it is an `Error` of the caller's) compared.
// Only decided differences are rewritten: the request id, the functions' directory (DV-03) and frame positions
// (DV-346). Local only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh,
// or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`run-missing: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../run-missing-app");

/** The component's directory, beside the app's files; for bunvex, its own config file names and imports. */
function prepare(project: string, dir: "convex" | "bunvex") {
  const fns = join(project, dir);
  cpSync(join(APP, "cmp"), join(fns, "cmp"), { recursive: true });
  if (dir === "convex") return;
  for (const d of [fns, join(fns, "cmp")]) {
    for (const name of readdirSync(d)) {
      if (!name.endsWith(".ts")) continue;
      const path = join(d, name);
      writeFileSync(
        path,
        readFileSync(path, "utf8")
          .replaceAll('"convex/server"', '"@bunvex/server"')
          .replaceAll("./cmp/convex.config", "./cmp/bunvex.config"),
      );
    }
    renameSync(join(d, "convex.config.ts"), join(d, "bunvex.config.ts"));
  }
}

let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex({ app: APP, prepare }), startBunvex({ app: APP, prepare })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

const decided = (s: string) =>
  s
    .replace(/\[Request ID: [0-9a-f]{16}\] /g, "")
    .replaceAll("../convex/", "../bunvex/")
    .replace(/:\d+:\d+\)/g, ":N:N)");

/** What the client sees of the call left uncaught, or what the function caught. */
async function answer(b: Backend, fn: string, op: string, target: string, caught: boolean) {
  const kind = fn === "probe:inMutation" ? "mutation" : "action";
  const { body } = await b.call(kind, fn, { op, target, caught });
  const a = body as { status: string; errorMessage?: string; value?: unknown };
  return a.status === "error" ? { error: decided(String(a.errorMessage)) } : a.value;
}

async function compare(fn: string, ops: string[], targets: string[], only?: (a: unknown) => unknown) {
  for (const op of ops)
    for (const target of targets)
      for (const caught of [false, true]) {
        const [c, x] = [await answer(convex, fn, op, target, caught), await answer(bunvex, fn, op, target, caught)];
        const pick = only ?? ((a: unknown) => a);
        expect({ fn, op, target, caught, answer: pick(x) }).toEqual({ fn, op, target, caught, answer: pick(c) });
      }
}

const APP_TARGETS = ["_deps/nonexistent", "nope:fn", "probe:nope", "probe:iq", "probe:q", "probe:m"];
const COMPONENT_TARGETS = ["components.cmp.lib.nope", "components.cmp.lib.priv", "components.nocmp.lib.x"];

/** An uncaught error's first line and a caught one's name, message and class: frames and realm left out. */
const firstLine = (a: unknown) => {
  const r = a as { error?: string; caught?: Record<string, unknown> };
  if (r.error !== undefined) return { error: r.error.split("\n").slice(0, 2).join("\n") };
  if (r.caught) return { name: r.caught.name, message: r.caught.message, ctor: r.caught.ctor };
  return a;
};

describe.skipIf(!ready)("a missing or mistyped function, against Convex's backend", () => {
  test("a V8 action's runQuery / runMutation / runAction / scheduler: Convex's `Couldn't resolve api.…`", async () => {
    await compare("probe:inAction", ["runQuery", "runMutation", "runAction", "runAfter"], APP_TARGETS);
    await compare("probe:inAction", ["runQuery", "runMutation", "runAction", "runAfter"], COMPONENT_TARGETS);
  });

  test("a V8 action's createFunctionHandle: the same miss", async () => {
    const missing = ["_deps/nonexistent", "probe:nope", ...COMPONENT_TARGETS];
    await compare("probe:inAction", ["handle", "handleQuery"], missing, firstLine);
  });

  test("a Node action's calls: the callee's display, a plain `Error`", async () => {
    await compare("node:inNode", ["runQuery", "runMutation", "runAction"], APP_TARGETS);
  });

  test("a mutation's runQuery / runMutation and scheduler: a plain `Error` with the lookup's message", async () => {
    await compare("probe:inMutation", ["runQuery", "runMutation", "runAfter"], APP_TARGETS, firstLine);
    await compare("probe:inMutation", ["runQuery", "runMutation", "runAfter"], COMPONENT_TARGETS, firstLine);
  });
});
