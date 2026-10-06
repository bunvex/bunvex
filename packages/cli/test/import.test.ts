// `bunvex import` end to end (STUDY-42 PR 3): the format from the extension or `--format`, `--table`'s rules,
// the upload in parts, the change summary and its prompt, progress, and Convex's messages.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { adminKeyCipherKey, createServer, Functions, issueAdminKey } from "@bunvex/server";
import { formatSize, importCommand } from "../src/import.ts";
import type { Io } from "../src/io.ts";
import { memoryStore } from "./memory-store.ts";

const SECRET = "79".repeat(32);
const NAME = "cli-import";
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
  const s = createServer({
    engine,
    functions: new Functions(engine),
    port: 0,
    fileStorage: null,
    exportStorage: null,
    importStorage: memoryStore() as never,
  });
  stops.push(() => s.shutdown());
  const dir = mkdtempSync(join(tmpdir(), "bunvex-cli-import-"));
  dirs.push(dir);
  const run = async (args: string[], answers: string[] = []) => {
    const err: string[] = [];
    const asked: string[] = [];
    const it: Io = {
      env: {
        BUNVEX_SELF_HOSTED_URL: `http://127.0.0.1:${s.server.port}`,
        BUNVEX_SELF_HOSTED_ADMIN_KEY: KEY,
        BUNVEX_IMPORT_CHUNK_SIZE: "10",
      },
      cwd: dir,
      out: () => {},
      err: (l) => err.push(l),
      prompt: (q) => {
        asked.push(q);
        return answers.shift() ?? null;
      },
    };
    return { code: await importCommand(args, it, { pollMs: 10 }), err, asked };
  };
  const docs = (table: string) =>
    engine.query(async (db) =>
      (await db.query(table).collect()).map(({ _id, _creationTime, ...rest }) => rest),
    ) as Promise<Record<string, unknown>[]>;
  return { engine, dir, run, docs };
}

test("Convex's formatSize", () => {
  expect([0, 1023, 1024, 1536, 5 * 1024 * 1024, 1024 * 1024 - 1].map(formatSize)).toEqual([
    "0 bytes",
    "1023 bytes",
    "1 KiB",
    "1.5 KiB",
    "5 MiB",
    "1 MiB",
  ]);
});

test("bunvex import: a CSV in parts; the summary and its prompt; Convex's messages", async () => {
  const t = await setup();
  writeFileSync(join(t.dir, "people.csv"), "name,age\nAda,36\nGrace,45\n");
  const first = await t.run(["people.csv", "--table", "people"]);
  expect(first.code).toBe(0);
  expect(first.err[0]).toBe("Importing people.csv (25 bytes)");
  expect(first.err).toContain("Uploading people.csv (20 bytes/25 bytes)");
  expect(first.err).toContain("Parsing uploaded data");
  // Nothing is deleted: the summary is shown without a prompt.
  expect(first.asked).toEqual([]);
  expect(first.err).toContain(
    [
      "Import change summary:",
      "table  | create | delete |",
      "--------------------------",
      "people | 2      | 0 of 0 |",
      "Once the import has started, it will run in the background.",
      "Interrupting `bunvex import` will not cancel it.",
    ].join("\n"),
  );
  expect(first.err.at(-1)).toBe('Added 2 documents to table "people".');
  expect(await t.docs("people")).toEqual([
    { age: 36, name: "Ada" },
    { age: 45, name: "Grace" },
  ]);

  // Not empty any more: requireEmpty fails.
  const again = await t.run(["people.csv", "--table", "people"]);
  expect(again.code).toBe(1);
  expect(again.err.at(-1)).toBe(
    'Importing data from "people.csv" to table "people" failed\n\nHit an error while importing:\nTable people already exists. Please choose a new table name or use replace/append modes.',
  );

  // Replacing deletes: asked first; "n" cancels, and nothing changes.
  writeFileSync(join(t.dir, "people.jsonl"), '{"name":"Linus"}\n');
  const no = await t.run(["people.jsonl", "--table", "people", "--replace"], ["n"]);
  expect(no.asked).toEqual(["Perform import? (Y/n)"]);
  expect(no).toMatchObject({ code: 1 });
  expect(no.err.at(-1)).toBe("Import canceled");
  expect((await t.docs("people")).length).toBe(2);
  // Without a terminal the CLI cannot ask.
  expect((await t.run(["people.jsonl", "--table", "people", "--replace"])).err.at(-1)).toBe(
    "Cannot prompt for input in non-interactive terminals. (Perform import?)",
  );
  // `--yes` skips the question.
  const yes = await t.run(["people.jsonl", "--table", "people", "--replace", "-y"]);
  expect(yes.code).toBe(0);
  expect(yes.asked).toEqual([]);
  expect(await t.docs("people")).toEqual([{ name: "Linus" }]);
});

test("bunvex import: the format and --table rules", async () => {
  const t = await setup();
  writeFileSync(join(t.dir, "data"), "[]");
  writeFileSync(join(t.dir, "data.json"), "[]");
  expect((await t.run(["missing.csv", "--table", "x"])).err).toEqual(["Error: Path missing.csv does not exist."]);
  expect((await t.run(["data", "--table", "x"])).err).toEqual([
    "No input file format inferred by the filename extension or specified. Specify your input file's format using the `--format` flag.",
  ]);
  expect((await t.run(["data.json"])).err).toEqual(["Error: The `--table` option is required for format jsonArray"]);
  expect((await t.run(["data", "--format", "zip", "--table", "x"])).err).toEqual([
    "Error: The `--table` option is not allowed for format zip",
  ]);
  const warned = await t.run(["data.json", "--format", "jsonLines", "--table", "x"]);
  expect(warned.err[0]).toBe(
    "Warning: Extension of file data.json (.json) does not match specified format: jsonLines (.jsonl).",
  );
  // --append with --replace: no error, as Convex's (its conflict check never fires); --append wins.
  const both = await t.run(["data.json", "--table", "x", "--replace", "--append"]);
  expect(both.code).toBe(0);
  expect(both.err.join("\n")).not.toContain("error:");
  const two = await t.run(["a.json", "b.json"]);
  expect([two.code, two.err[0]]).toEqual([1, "error: too many arguments for 'import'. Expected 1 argument but got 2."]);
  expect((await t.run([])).err[0]).toBe("error: missing required argument 'path'");
  // Without an extension, --format decides.
  const arr = await t.run(["data", "--format", "jsonArray", "--table", "empty"]);
  expect(arr.err.at(-1)).toBe('Added 0 documents to table "empty".');
});
