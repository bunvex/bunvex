// `bunvex export` end to end (STUDY-42 PR 1): request, follow, download into a directory (the server's file
// name) or to a new path; an existing file is refused, as Convex's CLI.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { adminKeyCipherKey, createServer, Functions, issueAdminKey } from "@bunvex/server";
import { v } from "@bunvex/values";
import { exportCommand } from "../src/export.ts";
import type { Io } from "../src/io.ts";
import { memoryStore } from "./memory-store.ts";

const SECRET = "78".repeat(32);
const NAME = "cli-export";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("bunvex export: into a directory, to a new file; an existing file is refused", async () => {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  await engine.mutation((db) => db.insert("items", { n: 1 }));
  const s = createServer({ engine, functions: new Functions(engine), port: 0, exportStorage: memoryStore() as never });
  stops.push(() => s.shutdown());
  const dir = mkdtempSync(join(tmpdir(), "bunvex-cli-export-"));
  dirs.push(dir);
  const run = async (...args: string[]) => {
    const err: string[] = [];
    const it: Io = {
      env: { BUNVEX_SELF_HOSTED_URL: `http://127.0.0.1:${s.server.port}`, BUNVEX_SELF_HOSTED_ADMIN_KEY: KEY },
      cwd: dir,
      out: () => {},
      err: (l) => err.push(l),
    };
    return { code: await exportCommand(args, it, { pollMs: 20 }), err };
  };
  mkdirSync(join(dir, "backups"));
  const intoDir = await run("--path", "backups");
  expect(intoDir.code).toBe(0);
  expect(intoDir.err[0]).toBe("Creating snapshot export");
  const ts = /^Created snapshot export at timestamp (\d+)$/.exec(intoDir.err.find((l) => l.startsWith("Created"))!)![1];
  expect(intoDir.err.at(-1)).toBe(
    `Downloaded snapshot export to ${join(dir, "backups", `snapshot_${NAME}_${ts}.zip`)}`,
  );
  expect(existsSync(join(dir, "backups", `snapshot_${NAME}_${ts}.zip`))).toBe(true);
  const toFile = await run("--path", "mine.zip");
  expect(toFile.code).toBe(0);
  expect(Bun.spawnSync(["unzip", "-Z1", join(dir, "mine.zip")]).stdout.toString()).toContain("items/documents.jsonl");
  writeFileSync(join(dir, "taken.zip"), "");
  expect(await run("--path", "taken.zip")).toEqual({ code: 1, err: ["Error: Path taken.zip already exists."] });
  const missing = await run();
  expect(missing.code).toBe(1);
  expect(missing.err.slice(0, 2)).toEqual(["error: required option '--path <zipFilePath>' not specified", ""]);
});
