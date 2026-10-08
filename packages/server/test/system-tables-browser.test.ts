// The system-table browser (STUDY-131 AD-24, a bunvex addition): `_system/debug/systemTables` lists every
// system table the catalog has, with its description; `_system/debug/systemTable` pages through one, private
// ones included, past the hidden index. An admin's own call with ViewData only: no key, a key without
// ViewData and function code (an action's runQuery) are all refused, and nothing writes.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine, SYSTEM_TABLE_DESCRIPTIONS, SYSTEM_TABLE_NUMBERS } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { action, adminCallerOf, Functions, mutation } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SECRET = "6b".repeat(32);
const NAME = "systables-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), memberId: 3 });
const READ_ONLY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), readOnly: true });

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

type Result = { status: string; value?: any; errorMessage?: string };

async function setup() {
  const engine = await new Engine(
    defineSchema({ notes: defineTable({ body: v.string() }).index("by_body", ["body"]) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  const functions = new Functions(engine).register("m", {
    add: mutation(({ db }, { body }: { body: string }) => db.insert("notes", { body })),
    // function code asking for a system table: refused whoever its caller is
    peek: action(async ({ runQuery }) => {
      try {
        return await runQuery("_system/debug/systemTable" as never, {
          table: "_tables",
          paginationOpts: { numItems: 5, cursor: null },
        });
      } catch (e) {
        return `refused: ${(e as Error).message}`;
      }
    }),
  });
  const s = createServer({ engine, functions, port: 0 });
  stops.push(() => s.shutdown());
  const api = `http://127.0.0.1:${s.server.port}`;
  const call = async (kind: string, path: string, args: object = {}, key: string | null = KEY): Promise<Result> =>
    (await (
      await fetch(`${api}/api/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bunvex ${key}` } : {}) },
        body: JSON.stringify({ path, args }),
      })
    ).json()) as Result;
  return { engine, functions, call };
}

const page = (table: string, numItems = 100, cursor: string | null = null) => ({
  table,
  paginationOpts: { numItems, cursor },
});

test("every numbered system table has a description, kept next to the numbers", () => {
  for (const name of Object.keys(SYSTEM_TABLE_NUMBERS)) expect(SYSTEM_TABLE_DESCRIPTIONS[name]).toBeTruthy();
});

test("the listing comes from the catalog: every system table it has, private ones marked, with sizes", async () => {
  const t = await setup();
  await t.call("mutation", "m:add", { body: "a" });
  const r = await t.call("query", "_system/debug/systemTables");
  expect(r.status).toBe("success");
  const rows = r.value as { name: string; description: string; appVisible: boolean; documentCount: number }[];
  const names = rows.map((x) => x.name);
  expect(names).toEqual([...names].sort());
  expect(names.every((n) => n.startsWith("_"))).toBe(true);
  expect(names).not.toContain("notes");
  // every system table's `_tables` row, `_tables` and `_index` included (STUDY-133: rows of their own)
  const catalog = (await t.engine.query((db) => db.asSystem(() => db.query("_tables").collect()))) as any[];
  expect(names).toEqual(
    catalog
      .filter((x) => x.name.startsWith("_") && (x.state ?? "active") === "active")
      .map((x) => x.name)
      .sort(),
  );
  const tables = rows.find((x) => x.name === "_tables")!;
  expect(tables.description).toBe(SYSTEM_TABLE_DESCRIPTIONS._tables!);
  expect(tables.appVisible).toBe(false);
  expect(tables.documentCount).toBe(catalog.length);
  expect(rows.find((x) => x.name === "_index")!.documentCount).toBeGreaterThan(0);
  if (names.includes("_storage")) expect(rows.find((x) => x.name === "_storage")!.appVisible).toBe(true);
});

test("a private system table: readable through the debug query only", async () => {
  const t = await setup();
  await t.call("mutation", "m:add", { body: "a" });
  // the CLI's tableData goes through db.system, which hides it: its reads find nothing, as Convex's (DV-360)
  const hidden = await t.call("query", "_system/cli/tableData", { ...page("_index"), order: "asc" });
  expect(hidden.status).toBe("success");
  expect(hidden.value.page).toEqual([]);
  const r = await t.call("query", "_system/debug/systemTable", page("_index"));
  expect(r.status).toBe("success");
  const docs = r.value.page as { table_id?: string; descriptor?: string; name?: string }[];
  expect(docs.length).toBeGreaterThan(0);
  expect(JSON.stringify(docs)).toContain("by_body");
  expect(r.value.isDone).toBe(true);
});

test("pages through a system table in order, with cursors", async () => {
  const t = await setup();
  const all = (await t.call("query", "_system/debug/systemTable", page("_tables"))).value.page as any[];
  expect(all.length).toBeGreaterThan(2);
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const r = await t.call("query", "_system/debug/systemTable", page("_tables", 2, cursor));
    seen.push(...(r.value.page as any[]).map((d) => d._id));
    if (r.value.isDone) break;
    cursor = r.value.continueCursor;
  }
  expect(seen).toEqual(all.map((d) => d._id));
  const desc = await t.call("query", "_system/debug/systemTable", { ...page("_tables"), order: "desc" });
  expect((desc.value.page as any[]).map((d) => d._id)).toEqual(all.map((d) => d._id).reverse());
});

test("a user table is not a system table; a missing system table reads empty", async () => {
  const t = await setup();
  const user = await t.call("query", "_system/debug/systemTable", page("notes"));
  expect(user.status).toBe("error");
  expect(user.errorMessage).toContain('"notes" is not a system table.');
  const missing = await t.call("query", "_system/debug/systemTable", page("_nope"));
  expect(missing.value).toMatchObject({ page: [], isDone: true });
});

test("refused without an admin key, without ViewData, and from function code", async () => {
  const t = await setup();
  for (const path of ["_system/debug/systemTables", "_system/debug/systemTable"]) {
    const anon = await t.call("query", path, path.endsWith("s") ? {} : page("_tables"), null);
    // A client that is not an admin is refused before the function is looked up, as Convex's runner (#471).
    expect(anon.status).toBe("error");
    expect(anon.errorMessage).toContain("You don't have permission to perform this operation.");
  }
  // a read-only key may view data
  expect((await t.call("query", "_system/debug/systemTables", {}, READ_ONLY)).status).toBe("success");
  const noView = adminCallerOf(
    { kind: "admin", memberId: 1, readOnly: true, allowedOps: ["ViewLogs"], issuedS: 0 },
    null,
  );
  expect(() => t.functions.checkQueryAccess("_system/debug/systemTable", noView)).toThrow("(deployment:data:view)");
  await expect(t.functions.runQuery("_system/debug/systemTables", {}, true, noView)).rejects.toThrow(
    "(deployment:data:view)",
  );
  // an action run by the admin still cannot reach it through runQuery
  const peek = await t.call("action", "m:peek");
  expect(peek.value).toStartWith("refused: ");
  // As Convex's `TaskExecutor::resolve`, which never resolves a system function for function code (#471).
  expect(peek.value).toContain("Couldn't resolve api._system.debug.systemTable");
});
