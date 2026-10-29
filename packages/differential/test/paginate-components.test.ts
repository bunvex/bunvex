// `paginate()` in a component's query (STUDY-186 A8, Convex d7402d6 and 8449d41) on Convex's backend (the oracle) and
// on bunvex's: the app of `paginate-components-app/` mounts `pager`, whose queries paginate its own table. A query
// pages once across the app and the component queries it calls, in either order; a component's failed query leaves no
// page behind; a mutation pages as often as it likes; and a subscription to a component's page keeps its boundary
// as rows are inserted inside and after it (the query journal). Every answer compared. Local only: skipped, with a
// note, when Convex's backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";
import { errorText } from "../harness/compare.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`paginate-components: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../paginate-components-app");

/** The component's directory, beside the app's files; for bunvex, its own config file names and imports. */
function prepare(project: string, dir: "convex" | "bunvex") {
  const fns = join(project, dir);
  cpSync(join(APP, "pager"), join(fns, "pager"), { recursive: true });
  if (dir === "convex") return;
  for (const d of [fns, join(fns, "pager")]) {
    for (const name of readdirSync(d)) {
      if (!name.endsWith(".ts")) continue;
      const path = join(d, name);
      writeFileSync(
        path,
        readFileSync(path, "utf8")
          .replaceAll('"convex/server"', '"@bunvex/server"')
          .replaceAll('"convex/values"', '"@bunvex/values"')
          .replaceAll("./pager/convex.config", "./pager/bunvex.config"),
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
  for (const b of [convex, bunvex]) {
    const r = await b.call("mutation", "app:seed", { ns: [10, 20, 30, 40] });
    if (!r.ok) throw new Error(`${b.name}: seed failed: ${JSON.stringify(r.body)}`);
  }
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

/** A call's value, or its error's text as the comparison sees it (DV-04's wording). */
async function answer(b: Backend, kind: "query" | "mutation", path: string, args: unknown = {}): Promise<unknown> {
  const r = await b.call(kind, path, args);
  const body = r.body as { status?: string; value?: unknown; errorMessage?: string };
  return body.status === "success"
    ? { value: errorsIn(body.value), logLines: (body as { logLines?: unknown }).logLines ?? [] }
    : {
        error: errorText(body.errorMessage ?? JSON.stringify(body)),
        logLines: (body as { logLines?: unknown }).logLines ?? [],
      };
}

/** Every caught message inside a value, as the comparison sees it. */
function errorsIn(v: unknown): unknown {
  if (typeof v === "string") return errorText(v);
  if (Array.isArray(v)) return v.map(errorsIn);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, errorsIn(x)]));
  return v;
}

const CALLS: [kind: "query" | "mutation", path: string, args?: unknown][] = [
  ["query", "app:viaComponent", { paginationOpts: { numItems: 2, cursor: null } }],
  ["query", "app:countThenPage"],
  ["query", "app:appThenComponent"],
  ["query", "app:appThenComponentCaught"],
  ["query", "app:appThenComponentUncaught"],
  ["query", "app:componentThenApp"],
  ["query", "app:componentThenAppUncaught"],
  ["query", "app:componentTwice"],
  ["query", "app:twiceInComponent"],
  ["query", "app:failedThenApp"],
  ["mutation", "app:fromMutation"],
];

const wanted = (n: number[]) => ({ isDone: false, ns: n });
const MULTIPLE =
  "This query function ran multiple paginated queries. bunvex only supports a single paginated query in each query function.";

/** What Convex answers to some of them, written out (the oracle's, checked against it). */
const EXPECTED: Record<string, unknown> = {
  "app:viaComponent": { value: wanted([10, 20]), logLines: ["[LOG] 'pager page' 2"] },
  // Refused where the call returns, in the app: the component's own `try` sees nothing, and its lines are dropped.
  "app:appThenComponentCaught": { value: { caught: MULTIPLE }, logLines: [] },
  "app:componentTwice": { value: { first: wanted([10]), caught: MULTIPLE }, logLines: ["[LOG] 'pager page' 1"] },
  "app:twiceInComponent": { value: { first: wanted([10]), caught: MULTIPLE }, logLines: [] },
  // A component's failed query leaves no page: the app pages after it.
  "app:failedThenApp": { value: { caught: "Uncaught Error: after the page", own: [10] }, logLines: [] },
};

describe.skipIf(!ready)("paginate() in component queries", () => {
  test("once per query across the app and its components, in either order; a mutation pages freely", async () => {
    for (const [kind, path, args] of CALLS) {
      const [c, b] = [await answer(convex, kind, path, args), await answer(bunvex, kind, path, args)];
      expect({ path, answer: b }).toEqual({ path, answer: c });
      if (path in EXPECTED) expect({ path, answer: c }).toEqual({ path, answer: EXPECTED[path] });
    }
  }, 120_000);

  test("a component's page goes on from its cursor", async () => {
    const pages = async (b: Backend) => {
      const out: number[][] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 4; i++) {
        const r = await b.call("query", "app:rawViaComponent", { paginationOpts: { numItems: 3, cursor } });
        const p = (r.body as { value: { page: { n: number }[]; isDone: boolean; continueCursor: string } }).value;
        out.push(p.page.map((d) => d.n));
        if (p.isDone) break;
        cursor = p.continueCursor;
      }
      return out;
    };
    const [c, b] = [await pages(convex), await pages(bunvex)];
    expect(b).toEqual(c);
    expect(c).toEqual([[10, 20, 30], [40]]);
  }, 60_000);

  // Last: it inserts into the component's table.
  test("a subscription to a component's page keeps its end as rows come in (the query journal)", async () => {
    const watch = async (b: Backend) => {
      const client = new ConvexClient(b.url, { unsavedChangesWarning: false });
      const seen: number[][] = [];
      let wake = () => {};
      const stop = client.onUpdate(
        makeFunctionReference<"query">("app:viaComponent"),
        { paginationOpts: { numItems: 2, cursor: null } },
        (v: { ns: number[] }) => {
          seen.push(v.ns);
          wake();
        },
      );
      const next = (count: number) =>
        new Promise<void>((done, fail) => {
          const t = setTimeout(() => fail(new Error(`${b.name}: no update ${count}: ${JSON.stringify(seen)}`)), 20_000);
          wake = () => {
            if (seen.length >= count) {
              clearTimeout(t);
              done();
            }
          };
          wake();
        });
      try {
        await next(1);
        // Inside the page: it grows, its end kept. After it: nothing changes.
        const insert = makeFunctionReference<"mutation">("app:insertItem");
        await client.mutation(insert, { n: 15 });
        await next(2);
        await client.mutation(insert, { n: 25 });
        // A query on the same client after the write: any transition for it would have come first.
        await client.query(makeFunctionReference<"query">("app:viaComponent"), {
          paginationOpts: { numItems: 1, cursor: null },
        });
        return seen;
      } finally {
        stop();
        await client.close();
      }
    };
    const [c, b] = [await watch(convex), await watch(bunvex)];
    expect(b).toEqual(c);
    expect(c).toEqual([
      [10, 20],
      [10, 15, 20],
    ]);
  }, 120_000);
});
