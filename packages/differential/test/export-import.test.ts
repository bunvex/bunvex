// Migrating from Convex (STUDY-139 P7): the way an app moves to bunvex is an export from Convex and an import into
// bunvex, each with its own CLI. Convex's backend gets notes and a stored file; `convex export
// --include-file-storage` writes its snapshot; bunvex, with the same app deployed, takes it with `bunvex import
// --replace-all`. Every document must come back with its id and creation time, by each kind of index, and the file
// with its metadata and bytes; then bunvex writes. Local only: skipped, with a note, when Convex's backend is not
// there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`export-import: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../cross-open-app");

async function value(b: Backend, kind: "query" | "mutation" | "action", path: string, args: unknown = {}) {
  const r = await b.call(kind, path, args);
  if (!r.ok) throw new Error(`${b.name} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body as { value: unknown }).value;
}

/** Everything the app can read back: the documents whole, by each kind of index, and the files. */
async function reads(b: Backend) {
  const files = (await value(b, "query", "notes:files")) as { _id: string }[];
  return {
    all: await value(b, "query", "notes:all"),
    byKind: await value(b, "query", "notes:byKind", { kind: "a" }),
    search: await value(b, "query", "notes:search", { text: "hello" }),
    nearest: await value(b, "action", "notes:nearest", { vector: [0, 1] }),
    files,
    texts: await Promise.all(files.map((f) => value(b, "action", "notes:fileText", { id: f._id }))),
  };
}

describe.skipIf(!ready)("an app moved from Convex to bunvex by export and import", () => {
  test("convex export, then bunvex import --replace-all: every document and file, as they were", async () => {
    const dir = mkdtempSync(join(tmpdir(), "export-import-"));
    const snapshot = join(dir, "snapshot.zip");
    let convex: Backend | null = null;
    let bunvex: Backend | null = null;
    try {
      convex = await startConvex({ app: APP });
      for (const note of [
        { body: "hello world", kind: "a", v: [1, 0] },
        { body: "hello there", kind: "b", v: [0, 1] },
        { body: "goodbye", kind: "a", v: [1, 1] },
      ])
        await value(convex, "mutation", "notes:add", note);
      await value(convex, "action", "notes:upload", { text: "a stored file" });
      const written = await reads(convex);
      expect(written).toMatchObject({
        byKind: ["hello world", "goodbye"],
        search: ["hello there", "hello world"],
        nearest: "hello there",
        texts: ["a stored file"],
      });
      expect((written.all as unknown[]).length).toBe(3);
      await convex.cli(["export", "--include-file-storage", "--path", snapshot]);
      await convex.stop();
      convex = null;
      expect(existsSync(snapshot)).toBe(true);

      bunvex = await startBunvex({ app: APP });
      await bunvex.cli(["import", "--replace-all", "--yes", snapshot]);
      expect(await reads(bunvex)).toEqual(written);
      // The imported table takes writes, by every index.
      await value(bunvex, "mutation", "notes:add", { body: "hello again", kind: "a", v: [3, 1] });
      expect(await value(bunvex, "query", "notes:byKind", { kind: "a" })).toEqual([
        "hello world",
        "goodbye",
        "hello again",
      ]);
      expect(await value(bunvex, "query", "notes:search", { text: "hello" })).toEqual([
        "hello again",
        "hello there",
        "hello world",
      ]);
    } finally {
      await convex?.stop();
      await bunvex?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
