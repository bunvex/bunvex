// `data --component` (STUDY-43, DV-224 resolved) with each backend's own CLI, on an app mounting the rate limiter
// (rate-limiter-app/: `@convex-dev/rate-limiter` on Convex's backend, `@bunvex/rate-limiter` on bunvex's): the same
// table list in the component and in its child, the same documents (system fields and the limits' values by form), the
// same empty table's message, and a path no component has failing on both. Local only: skipped, with a note, when
// Convex's backend is not there.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`data-component: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../rate-limiter-app");
let convex: Backend;
let bunvex: Backend;

/** bunvex's project installs `@bunvex/rate-limiter` where Convex's has `@convex-dev/rate-limiter`. */
function prepare(project: string, dir: "convex" | "bunvex") {
  if (dir !== "bunvex") return;
  const functions = join(project, dir);
  renameSync(join(functions, "convex.config.ts"), join(functions, "bunvex.config.ts"));
  for (const name of ["bunvex.config.ts", "limits.ts"]) {
    const file = join(functions, name);
    writeFileSync(
      file,
      readFileSync(file, "utf8")
        .replaceAll('"@convex-dev/rate-limiter/convex.config"', '"@bunvex/rate-limiter/bunvex.config.js"')
        .replaceAll('"@convex-dev/rate-limiter"', '"@bunvex/rate-limiter"'),
    );
  }
}

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex({ app: APP, prepare }), startBunvex({ app: APP, prepare })]);
  for (const b of [convex, bunvex]) {
    const r = await b.call("mutation", "limits:limit", { name: "bucket", calls: [{ key: "alice" }, { key: "bob" }] });
    if (!r.ok) throw new Error(`${b.name}: limit failed: ${JSON.stringify(r.body)}`);
  }
}, 300_000);
afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

/** The CLI's exit code, its output and its error's message lines (not a stack, not a request id). */
async function data(b: Backend, ...args: string[]) {
  const r = await b.cliOutput(["data", ...args], {});
  const err = r.err
    .split("\n")
    .filter((l) => l !== "" && !/^\s+at /.test(l) && !l.includes("Called by client"))
    .map((l) =>
      l
        .replace(/\[Request ID: [0-9a-f]+\] /, "")
        .replace(/^Error: \[(CONVEX|BUNVEX) Q\(/, "Error: [Q(")
        .replace(/^bunvex data: /, ""),
    );
  return { code: r.code, out: r.out, err };
}

/** A JSON array of documents with their ids, times and float values by form, sorted. */
const documents = (out: string) =>
  (JSON.parse(out) as Record<string, unknown>[])
    .map((d) =>
      Object.fromEntries(
        Object.entries(d).map(([k, v]) => [
          k,
          k === "_id"
            ? "<id>"
            : k === "_creationTime" || k === "ts"
              ? "<time>"
              : typeof v === "number"
                ? Math.round(v)
                : v,
        ]),
      ),
    )
    .sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));

describe.skipIf(!ready)("data --component, Convex's CLI and backend vs bunvex's", () => {
  test("a component's tables, and its child's", async () => {
    for (const component of ["rateLimiter", "rateLimiter/batchWorker"]) {
      const [c, x] = [await data(convex, "--component", component), await data(bunvex, "--component", component)];
      expect({ component, ...x }).toEqual({ component, ...c });
    }
  });

  test("a component table's documents", async () => {
    const [c, x] = [
      await data(convex, "rateLimits", "--component", "rateLimiter", "--format", "jsonArray"),
      await data(bunvex, "rateLimits", "--component", "rateLimiter", "--format", "jsonArray"),
    ];
    expect(x.code).toBe(0);
    expect(c.code).toBe(0);
    expect(documents(x.out)).toEqual(documents(c.out));
    expect(documents(c.out).length).toBe(2);
  });

  test("an empty table, and the app's own tables", async () => {
    for (const args of [["pendingUpdates", "--component", "rateLimiter"], []]) {
      const [c, x] = [await data(convex, ...args), await data(bunvex, ...args)];
      expect({ args, ...x }).toEqual({ args, ...c });
    }
  });

  test("a path no component has fails on both, naming it", async () => {
    const [c, x] = [await data(convex, "--component", "nope"), await data(bunvex, "--component", "nope")];
    expect(c.code).toBe(1);
    expect(x.code).toBe(1);
    expect(c.err.join("\n")).toContain("Component path 'nope' not found");
    expect(x.err.join("\n")).toContain("Component path 'nope' not found");
  });
});
