// The CLI's `data` lists the root's tables only (STUDY-152 step 1): on a store with components (the Convex
// binary's, packages/core/test/component-namespaces.test.ts describes it), a component's `counters` and its own
// `messages` are not the root's.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { v } from "@bunvex/values";
import { Functions } from "../src/functions.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("_system/cli/tables lists the root's tables, not a component's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-component-tables-"));
  dirs.push(dir);
  const path = join(dir, "convex_local_backend.sqlite3");
  writeFileSync(
    path,
    Bun.gunzipSync(readFileSync(join(import.meta.dir, "fixtures/convex-store-components.sqlite3.gz"))),
  );
  const schema = defineSchema({ messages: defineTable({ text: v.string() }).index("by_text", ["text"]) });
  const engine = await new Engine(schema, new SqlitePersistence(path, { durable: false })).init();
  try {
    const functions = new Functions(engine);
    const page = (await functions.runQuery(
      "_system/cli/tables",
      { paginationOpts: { numItems: 10, cursor: null } },
      false,
    )) as { page: { name: string }[] };
    expect(page.page).toEqual([{ name: "messages" }]);
  } finally {
    await engine.close();
  }
});
