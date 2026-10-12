// INDEX_BACKFILL_ENABLE (STUDY-147 §3.5), Convex's emergency switch: off, no database index is backfilled, so a
// push that adds one waits for ever (its schema change stays in progress) and a query on it is refused; switched
// back on, the next start backfills it and the push completes.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const engines: Engine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-backfill-switch-"));
  dirs.push(d);
  return join(d, "db.sqlite");
};
const open = async (path: string, enabled: boolean) => {
  const e = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    new SqlitePersistence(path, { durable: true }),
    { storedSchema: true, indexBackfill: { enabled, chunkRate: null } },
  ).init();
  engines.push(e);
  return e;
};
const withIndexes = defineSchema({
  items: defineTable({ n: v.number() }).index("by_n", ["n"]),
  fresh: defineTable({ s: v.string() }).index("by_s", ["s"]),
});

test("off: a push adding indexes, on a table with documents or a new one, stays in progress", async () => {
  const path = tmp();
  const e = await open(path, false);
  await e.mutation(async (db) => {
    for (let n = 0; n < 50; n++) await db.insert("items", { n });
  });
  const push = await e.startSchemaPush(withIndexes);
  await Bun.sleep(300);
  expect((await e.schemaPushStatus(push.schemaId)).type).toBe("inProgress");
  await e.close();
  // Switched back on: the next start backfills them, and the push completes.
  const e2 = await open(path, true);
  for (let i = 0; i < 200 && (await e2.schemaPushStatus(push.schemaId)).type !== "complete"; i++) await Bun.sleep(10);
  expect((await e2.schemaPushStatus(push.schemaId)).type).toBe("complete");
});

test("the knob is read from the environment, as a bool (default true)", async () => {
  const read = async (value?: string) => {
    const p = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { INDEX_BACKFILL_DEFAULTS } = await import(${JSON.stringify(join(import.meta.dir, "../src/index-worker.ts"))}); console.log(INDEX_BACKFILL_DEFAULTS.enabled);`,
      ],
      { env: { ...process.env, INDEX_BACKFILL_ENABLE: value }, stdout: "pipe", stderr: "pipe" },
    );
    return (await new Response(p.stdout).text()).trim().split("\n").at(-1);
  };
  expect(await read(undefined)).toBe("true");
  expect(await read("false")).toBe("false");
  expect(await read("off")).toBe("true"); // not a bool: the default, as Convex's `env_config`
});
