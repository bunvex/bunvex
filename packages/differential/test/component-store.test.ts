// A store with components, as the Convex binary writes it, opened by bunvex (STUDY-152 steps 1–2). Convex deploys
// the app of `component-store-app/` with its `counter` component mounted twice; each component has a `messages`
// table, the root's name. bunvex, given the same store (its deploy has no components yet: convex.config.ts and
// seed.ts left out), must read and write the root's tables only, and list only the root's in `data`. Then Convex
// opens the store again: its components' data is untouched. Skipped without Convex's backend.
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type Backend,
  newStore,
  ORACLE_BIN,
  type StartOptions,
  startBunvex,
  startConvex,
} from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`component-store: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../component-store-app");

async function value(b: Backend, kind: "query" | "mutation", path: string, args: unknown = {}) {
  const r = await b.call(kind, path, args);
  if (!r.ok) throw new Error(`${b.name} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body as { value: unknown }).value;
}

/** The component's directory for Convex; for bunvex, the app without its components. */
function prepare(project: string, dir: "convex" | "bunvex") {
  if (dir === "convex") cpSync(join(APP, "counter"), join(project, dir, "counter"), { recursive: true });
  else for (const name of ["convex.config.ts", "seed.ts"]) rmSync(join(project, dir, name));
}

describe.skipIf(!ready)("a store with components", () => {
  test("Convex's store opened by bunvex: the root's tables only, then Convex finds its components intact", async () => {
    const store = newStore();
    const opts: StartOptions = { store, app: APP, prepare };
    try {
      const convex = await startConvex(opts);
      await value(convex, "mutation", "seed:seed");
      expect(await value(convex, "query", "app:list")).toEqual(["root"]);
      await convex.stop();

      const bunvex = await startBunvex(opts);
      expect(await value(bunvex, "query", "app:list")).toEqual(["root"]);
      await value(bunvex, "mutation", "app:add", { text: "after" });
      expect(await value(bunvex, "query", "app:list")).toEqual(["root", "after"]);
      // `data` lists the root's tables: not a component's `counters`, nor its `messages` twice.
      const tables = (await bunvex.cli(["data"])).trim().split(/\s+/);
      expect(tables).toContain("messages");
      expect(tables).not.toContain("counters");
      expect(tables.filter((t) => t === "messages")).toHaveLength(1);
      await bunvex.stop();

      const again = await startConvex(opts);
      expect(await value(again, "query", "app:list")).toEqual(["root", "after"]);
      expect(await value(again, "query", "seed:counterMessages")).toEqual(["in counter"]);
      await again.stop();
    } finally {
      rmSync(store.dir, { recursive: true, force: true });
    }
  }, 300_000);
});
