// Cross-open (STUDY-133 PR 9, Q11): a store one binary wrote, opened by the other. Each starts on the same
// SQLite file and storage directory, redeploys the app with its own CLI (the code is never shared, §6.4), and
// must read every document back by each kind of index — the search and vector indexes rebuilt from the table,
// since neither reads the other's segments (Q5, DV-415) — then write; the first binary reads the result back.
// Local only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or
// CONVEX_BACKEND_BIN).
import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
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
if (!ready) console.warn(`cross-open: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../cross-open-app");
const start = { convex: startConvex, bunvex: startBunvex } as const;

async function value(b: Backend, kind: "query" | "mutation" | "action", path: string, args: unknown = {}) {
  const r = await b.call(kind, path, args);
  if (!r.ok) throw new Error(`${b.name} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body as { value: unknown }).value;
}

/** What every binary must read from the store: by the table, the database index, text and vector search. */
async function reads(b: Backend) {
  return {
    list: await value(b, "query", "notes:list"),
    byKind: await value(b, "query", "notes:byKind", { kind: "a" }),
    search: await value(b, "query", "notes:search", { text: "hello" }),
    nearest: await value(b, "action", "notes:nearest", { vector: [0, 1] }),
  };
}

async function roundTrip(first: "convex" | "bunvex", second: "convex" | "bunvex") {
  const store = newStore();
  const opts: StartOptions = { store, app: APP };
  try {
    const a = await start[first](opts);
    for (const note of [
      { body: "hello world", kind: "a", v: [1, 0] },
      { body: "hello there", kind: "b", v: [0, 1] },
      { body: "goodbye", kind: "a", v: [1, 1] },
    ])
      await value(a, "mutation", "notes:add", note);
    const written = await reads(a);
    expect(written).toEqual({
      list: ["hello world", "hello there", "goodbye"],
      byKind: ["hello world", "goodbye"],
      search: ["hello there", "hello world"],
      nearest: "hello there",
    });
    await a.stop();
    expect(existsSync(join(store.dir, "store.sqlite3"))).toBe(true);

    const b = await start[second](opts);
    expect(await reads(b)).toEqual(written);
    await value(b, "mutation", "notes:add", { body: "hello again", kind: "a", v: [3, 1] });
    await b.stop();

    // Back on the first binary: the second one's write is there, by every index.
    const c = await start[first](opts);
    expect(await reads(c)).toEqual({
      list: ["hello world", "hello there", "goodbye", "hello again"],
      byKind: ["hello world", "goodbye", "hello again"],
      search: ["hello again", "hello there", "hello world"],
      nearest: "hello there",
    });
    await c.stop();
  } finally {
    rmSync(store.dir, { recursive: true, force: true });
  }
}

describe.skipIf(!ready)("a store moved between the two binaries", () => {
  test("bunvex's store opened by Convex, then by bunvex again", () => roundTrip("bunvex", "convex"), 300_000);
  test("Convex's store opened by bunvex, then by Convex again", () => roundTrip("convex", "bunvex"), 300_000);
});
