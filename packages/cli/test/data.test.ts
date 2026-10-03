// `bunvex data` end to end (STUDY-43), as `npx convex data`: the user tables; a table's documents as a table,
// a JSON array or lines, each value printed as Convex's CLI prints it; `--limit`, `--order`, the warnings,
// the empty messages, `_storage`, a narrow terminal.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { adminKeyCipherKey, createServer, Functions, issueAdminKey, mutation } from "@bunvex/server";
import { dataCommand, documentsTable, stringify } from "../src/data.ts";
import type { Io } from "../src/io.ts";
import { memoryStore } from "./memory-store.ts";

const SECRET = "7a".repeat(32);
const NAME = "cli-data";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup() {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false }), {
    instanceName: NAME,
    instanceSecret: SECRET,
  }).init();
  const functions = new Functions(engine).register("m", {
    uploadUrl: mutation(async ({ storage }) => storage.generateUploadUrl()),
  });
  const s = createServer({ engine, functions, port: 0, fileStorage: memoryStore() as never, exportStorage: null });
  stops.push(() => s.shutdown());
  const dir = mkdtempSync(join(tmpdir(), "bunvex-cli-data-"));
  dirs.push(dir);
  const run = async (args: string[], tty?: { columns: number }) => {
    const out: string[] = [];
    const err: string[] = [];
    const it: Io = {
      env: { BUNVEX_SELF_HOSTED_URL: `http://127.0.0.1:${s.server.port}`, BUNVEX_SELF_HOSTED_ADMIN_KEY: KEY },
      cwd: dir,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      ...(tty ? { isTTY: true, columns: tty.columns } : {}),
    };
    return { code: await dataCommand(args, it), out: out.join("\n"), err };
  };
  return { engine, run, api: `http://127.0.0.1:${s.server.port}`, functions };
}

test("Convex's stringify", () => {
  expect(
    [null, 5n, 1.5, -0, Number.NaN, true, 'a"b', new Uint8Array([1, 2]).buffer, [1, "x"], { a: 1, b: { c: null } }].map(
      (v) => stringify(v as never),
    ),
  ).toEqual([
    "null",
    "5n",
    "1.5",
    "0",
    "NaN",
    "true",
    '"a\\"b"',
    'Bytes("AQI=")',
    '[1, "x"]',
    '{ "a": 1, "b": { "c": null } }',
  ]);
});

test("the documents table: _id, _creationTime, then the fields sorted, padded; cut to a terminal's width", () => {
  const rows: Record<string, string>[] = [
    { _id: '"a"', _creationTime: "1", name: '"Ada"' },
    { _id: '"bb"', _creationTime: "2", age: "36" },
  ];
  // As Convex's: the widths come from the values only, so a longer header name runs past its column.
  expect(documentsTable(rows).lines).toEqual([
    "_id  | _creationTime | age | name ",
    "-----|---|----|------",
    '"a"  | 1 |    | "Ada"',
    '"bb" | 2 | 36 |      ',
  ]);
  const cut = documentsTable(rows, 30);
  expect(cut.truncated).toBe(true);
  expect(cut.lines[0]).toBe("_id  | _creationTime");
});

test("bunvex data: tables, documents in each format, the limit warning, _storage, the empty messages", async () => {
  const t = await setup();
  expect(await t.run([])).toEqual({ code: 0, out: "", err: ["There are no tables in the database."] });
  // Created first, listed last: the names are sorted.
  await t.engine.mutation((db) => db.insert("zeta", {}));
  const ids: string[] = [];
  for (const [i, doc] of [{ n: 1n }, { n: 2.5, s: "x" }, { b: true }].entries()) {
    ids.push(await t.engine.mutation((db) => db.insert(i === 2 ? "beta" : "alpha", doc)));
  }
  expect((await t.run([])).out).toBe("alpha\nbeta\nzeta");
  const docs = (await t.engine.query((db) => db.query("alpha").order("desc").collect())) as unknown as Record<
    string,
    never
  >[];
  const lines = docs.map((d) => stringify(d));
  expect((await t.run(["alpha", "--format", "jsonl"])).out).toBe(lines.join("\n"));
  expect((await t.run(["alpha", "--format", "json"])).out).toBe(`[\n${lines.join(",\n")}\n]`);
  // A bigint prints with its `n` (which document comes first depends on two same-millisecond inserts).
  expect(lines.some((l) => l.includes('"n": 1n'))).toBe(true);
  // Oldest first, one of two: the warning.
  const one = await t.run(["alpha", "--order", "asc", "--limit", "1"]);
  const oldest = (await t.engine.query((db) => db.query("alpha").order("asc").first())) as { _id: string };
  expect(one.out.split("\n")[2]).toContain(`"${oldest._id}"`);
  expect(one.err).toEqual(["Showing the 1 oldest created document. Use the --limit option to see more."]);
  expect((await t.run(["alpha", "--limit", "1"])).err).toEqual([
    "Showing the 1 most recently created document. Use the --limit option to see more.",
  ]);
  expect((await t.run(["alpha"])).err).toEqual([]);
  expect(await t.run(["gamma"])).toEqual({ code: 0, out: "", err: ["There are no documents in this table."] });
  // A narrow terminal cuts the lines and says so.
  const narrow = await t.run(["alpha"], { columns: 40 });
  expect(narrow.out.split("\n").every((l) => l.length <= 30)).toBe(true);
  expect(narrow.err[0]).toBe(
    "Lines were truncated to fit the terminal width. Pipe the command to see the full output, such as:\n  `bunvex data tableName | less -S`",
  );
  // A system table, through `db.system`.
  const url = (await t.functions.runMutation("m:uploadUrl", {})) as string;
  await fetch(url, { method: "POST", body: "hi", headers: { "content-type": "text/plain" } });
  const files = await t.run(["_storage", "--format", "jsonl"]);
  expect(files.out).toContain('"contentType": "text/plain"');
  expect(files.out).not.toContain("storageKey");
  // Options.
  expect((await t.run(["alpha", "--limit", "0"])).code).toBe(2);
  expect((await t.run(["alpha", "--order", "up"])).code).toBe(2);
  expect((await t.run(["alpha", "--format", "csv"])).code).toBe(2);
  expect((await t.run(["alpha", "--component", "x"])).err).toEqual([
    "bunvex data: --component: bunvex does not have components yet.",
  ]);
});
