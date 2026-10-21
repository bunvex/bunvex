// A component's `process.env` (STUDY-171 §15.7, Q-PR7-1) on Convex's backend (the oracle) and on bunvex's: the app of
// `component-env-app/` mounts `envc` twice, once with its variables bound (`MODE` a value, `KEY` the app's `APPKEY`) and
// once with none, and the app has variables of its own (`APPKEY`, `SECRET`). Each component reads its bindings and never
// the app's variables, whoever calls it: the app's query, mutation or action, another component through a handle; the
// app, called back through a handle, reads its own. Every call is made before the app's variables are set (a binding to
// an unset variable) and after, and its whole value compared. Local only: skipped, with a note, when Convex's backend is
// not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`component-env: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../component-env-app");

/** The component's directory, beside the app's files; for bunvex, its own config file names and imports. */
function prepare(project: string, dir: "convex" | "bunvex") {
  const fns = join(project, dir);
  cpSync(join(APP, "envc"), join(fns, "envc"), { recursive: true });
  if (dir === "convex") return;
  for (const d of [fns, join(fns, "envc")]) {
    for (const name of readdirSync(d)) {
      if (!name.endsWith(".ts")) continue;
      const path = join(d, name);
      writeFileSync(
        path,
        readFileSync(path, "utf8")
          .replaceAll('"convex/server"', '"bunvex/server"')
          .replaceAll('"convex/values"', '"bunvex/values"')
          .replaceAll("./envc/convex.config", "./envc/bunvex.config"),
      );
    }
    renameSync(join(d, "convex.config.ts"), join(d, "bunvex.config.ts"));
  }
}

let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await Promise.all([startConvex({ app: APP, prepare }), startBunvex({ app: APP, prepare })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

const CALLS = [
  ["query", "app:appEnv"],
  ["mutation", "app:appEnvMut"],
  ["query", "app:appBadName"],
  ["query", "app:viaQuery"],
  ["mutation", "app:viaMutation"],
  ["action", "app:viaAction"],
  ["query", "app:componentToComponent"],
  ["mutation", "app:componentToComponentMut"],
  ["query", "app:componentToApp"],
  ["mutation", "app:componentToAppMut"],
] as const;

async function value(b: Backend, kind: "query" | "mutation" | "action", path: string) {
  const r = await b.call(kind, path, {});
  const body = r.body as { status?: string; value?: unknown; errorMessage?: string };
  return body.status === "success" ? { value: body.value } : { error: body.errorMessage ?? body };
}

const unset = { MODE: null, KEY: null, APPKEY: null, SECRET: null, NOPE: null };
const set = { ...unset, APPKEY: "app-key", SECRET: "app-secret" };
const envc = (key: string | null) => ({ ...unset, MODE: "fast", KEY: key });

/** What each call reads on Convex, written out (the oracle's, checked below against it). */
const expected = (key: string | null) => {
  const app = key === null ? unset : set;
  return {
    "app:appEnv": { value: app },
    "app:appEnvMut": { value: app },
    "app:viaQuery": {
      value: { before: app, envc: envc(key), second: unset, bad: expect.anything(), after: app },
    },
    "app:viaMutation": { value: { before: app, envc: envc(key), second: unset, stale: envc(key), after: app } },
    "app:viaAction": { value: { envc: envc(key), second: unset } },
    "app:componentToComponent": { value: { before: envc(key), inner: unset, after: envc(key) } },
    "app:componentToComponentMut": { value: { before: envc(key), inner: unset, after: envc(key) } },
    "app:componentToApp": {
      value: { before: app, call: { before: envc(key), inner: app, after: envc(key) }, after: app },
    },
    "app:componentToAppMut": {
      value: { before: app, call: { before: envc(key), inner: app, after: envc(key) }, after: app },
    },
  } as Record<string, unknown>;
};

describe.skipIf(!ready)("a component's process.env", () => {
  const both = async () => {
    const out: Record<string, { convex: unknown; bunvex: unknown }> = {};
    for (const [kind, path] of CALLS)
      out[path] = { convex: await value(convex, kind, path), bunvex: await value(bunvex, kind, path) };
    return out;
  };

  const check = (out: Record<string, { convex: unknown; bunvex: unknown }>, key: string | null) => {
    const want = expected(key);
    for (const [path, { convex: c, bunvex: b }] of Object.entries(out)) {
      expect({ path, value: b }).toEqual({ path, value: c });
      if (path in want) expect({ path, value: c }).toEqual({ path, value: want[path] });
    }
  };

  test("before the app's variables are set: a binding to an unset variable reads nothing", async () => {
    check(await both(), null);
  }, 120_000);

  test("after: each component its own bindings, the app its own variables, whoever calls", async () => {
    for (const b of [convex, bunvex]) {
      await b.cli(["env", "set", "APPKEY", "app-key"]);
      await b.cli(["env", "set", "SECRET", "app-secret"]);
    }
    check(await both(), "app-key");
  }, 120_000);
});
