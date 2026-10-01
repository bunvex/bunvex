import { describe, expect, test } from "bun:test";
import type { SnapshotImport, SnapshotImportRequest } from "@bunvex/dashboard/data-source";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { parseCsv } from "../src/mock/snapshots.ts";
import { readZip, writeZip } from "../src/mock/zip.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const make = (opts: Partial<ConstructorParameters<typeof MockDataSource>[0]> = {}) =>
  new MockDataSource({
    seed: 3,
    now: NOW,
    executions: 5,
    documents: { tasks: 6, users: 3, messages: 2, imports: 0 },
    snapshotStepMs: 1,
    ...opts,
  });

async function exportZip(src: MockDataSource, includeStorage = false) {
  await src.files.ready;
  const e = await src.requestSnapshotExport({ includeStorage });
  for (let i = 0; i < 500; i++) {
    const now = await src.getLatestSnapshotExport();
    if (now?.state === "completed") return new Uint8Array(await (await src.downloadSnapshotExport(e.id)).arrayBuffer());
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("export did not finish");
}

async function importFile(src: MockDataSource, req: SnapshotImportRequest, confirm = true): Promise<SnapshotImport> {
  const started = await src.startSnapshotImport(req);
  if (started.state !== "waiting_for_confirmation" || !confirm) return started;
  await src.confirmSnapshotImport(started.id);
  for (let i = 0; i < 500; i++) {
    const s = await src.getSnapshotImport(started.id);
    if (s.state === "completed" || s.state === "failed") return s;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("import did not finish");
}
const count = async (src: MockDataSource, table: string) =>
  (await src.listTables()).find((t) => t.name === table)?.documentCount;

describe("snapshot export (UI-01 §19.2)", () => {
  test("a zip in Convex's layout: a folder per table, the table list, and the files when asked", async () => {
    const src = make();
    const entries = await readZip(await exportZip(src, true));
    const names = entries.map((e) => e.name);
    expect(names).toContain("_tables/documents.jsonl");
    expect(names).toContain("tasks/documents.jsonl");
    expect(names).toContain("_storage/documents.jsonl");
    const tasks = new TextDecoder().decode(entries.find((e) => e.name === "tasks/documents.jsonl")!.data);
    expect(tasks.trim().split("\n")).toHaveLength(6);
    const files = (await src.listFiles({ numItems: 100, cursor: null })).page;
    for (const f of files) expect(names).toContain(`_storage/${f.id}`);
    expect(src.audit.list({ numItems: 50, cursor: null }).page.some((e) => e.action === "request_export")).toBe(true);
  });

  test("a newer request replaces the latest; an unfinished one cannot be downloaded", async () => {
    const src = make({ snapshotStepMs: 50 });
    const first = await src.requestSnapshotExport({ includeStorage: false });
    await expect(src.downloadSnapshotExport(first.id)).rejects.toThrow("not completed");
    const second = await src.requestSnapshotExport({ includeStorage: false });
    expect((await src.getLatestSnapshotExport())?.id).toBe(second.id);
    await expect(src.downloadSnapshotExport(first.id)).rejects.toThrow("only the latest");
  });
});

describe("snapshot import (UI-01 §19.2)", () => {
  test("an export imports back into another deployment, ids and creation times kept", async () => {
    const from = make();
    const zip = await exportZip(from);
    const to = make({ documents: { tasks: 0, users: 0, messages: 0, imports: 0 } });
    const done = await importFile(to, { file: new Blob([zip]), format: "zip", mode: "requireEmpty" });
    expect(done.state).toBe("completed");
    expect(done.rowsWritten).toBe(11);
    const a = (await from.listDocuments({ table: "tasks", numItems: 50, cursor: null })).page;
    const b = (await to.listDocuments({ table: "tasks", numItems: 50, cursor: null })).page;
    expect(b).toEqual(a);
    expect(
      to.audit.list({ numItems: 50, cursor: null }).page.find((e) => e.action === "snapshot_import")?.metadata,
    ).toMatchObject({
      import_format: "zip",
      import_mode: "requireEmpty",
    });
  });

  test("modes: requireEmpty refuses a table with documents; append adds; replace empties first", async () => {
    const src = make();
    const file = () => new Blob(['{"text":"x"}\n{"text":"y"}\n']);
    const refused = await importFile(src, { file: file(), format: "jsonLines", mode: "requireEmpty", table: "tasks" });
    expect(refused).toMatchObject({
      state: "failed",
      error: 'tasks already has 6 documents: import with "append" or "replace"',
    });
    const waiting = await importFile(src, { file: file(), format: "jsonLines", mode: "append", table: "tasks" }, false);
    expect(waiting.changes).toEqual([{ table: "tasks", add: 2, delete: 0 }]);
    expect((await importFile(src, { file: file(), format: "jsonLines", mode: "append", table: "tasks" })).state).toBe(
      "completed",
    );
    expect(await count(src, "tasks")).toBe(8);
    const replaced = await importFile(
      src,
      { file: file(), format: "jsonLines", mode: "replace", table: "tasks" },
      false,
    );
    expect(replaced.changes).toEqual([{ table: "tasks", add: 2, delete: 8 }]);
    await src.confirmSnapshotImport(replaced.id);
    for (let i = 0; i < 200 && (await src.getSnapshotImport(replaced.id)).state !== "completed"; i++)
      await new Promise((r) => setTimeout(r, 2));
    expect(await count(src, "tasks")).toBe(2);
  });

  test("replaceAll (a zip) also empties every table it does not have; a new table is created", async () => {
    const src = make();
    // a zip with users only (two documents)
    const zip = writeZip([
      { name: "users/documents.jsonl", data: new TextEncoder().encode('{"name":"a"}\n{"name":"b"}\n') },
    ]);
    const waiting = await importFile(src, { file: new Blob([zip]), format: "zip", mode: "replaceAll" }, false);
    expect(waiting.changes).toEqual(
      expect.arrayContaining([
        { table: "tasks", add: 0, delete: 6 },
        { table: "users", add: 2, delete: 3 },
      ]),
    );
    await src.confirmSnapshotImport(waiting.id);
    for (let i = 0; i < 200 && (await src.getSnapshotImport(waiting.id)).state !== "completed"; i++)
      await new Promise((r) => setTimeout(r, 2));
    expect([await count(src, "tasks"), await count(src, "users"), await count(src, "messages")]).toEqual([0, 2, 0]);
    expect((await src.getSnapshotImport(waiting.id)).checkpoints).toContain("Deleted 6 documents from tasks");
    const done = await importFile(make(), {
      file: new Blob(['[{"a":1}]']),
      format: "jsonArray",
      mode: "requireEmpty",
      table: "fresh",
    });
    expect(done.state).toBe("completed");
  });

  test("mistakes are said: bad JSON (with its line), a reserved field, no table for a JSON file, a clashing id", async () => {
    const src = make();
    const bad = await importFile(src, {
      file: new Blob(['{"a":1}\n{oops\n']),
      format: "jsonLines",
      mode: "append",
      table: "t",
    });
    expect(bad.error).toBe("the file, line 2: not valid JSON");
    const reserved = await importFile(src, {
      file: new Blob(['[{"_x":1}]']),
      format: "jsonArray",
      mode: "append",
      table: "t",
    });
    expect(reserved.error).toBe('item 1: "_x" — field names cannot start with an underscore');
    const noTable = await importFile(src, { file: new Blob(["[]"]), format: "jsonArray", mode: "append" });
    expect(noTable.error).toBe("a table is needed for the jsonArray format");
    const [task] = (await src.listDocuments({ table: "tasks", numItems: 1, cursor: null })).page;
    const clash = await importFile(src, {
      file: new Blob([JSON.stringify({ _id: task!._id })]),
      format: "jsonLines",
      mode: "append",
      table: "tasks",
    });
    expect(clash.error).toBe(`tasks already has a document ${task!._id}`);
    const notZip = await importFile(src, { file: new Blob(["hi"]), format: "zip", mode: "replace" });
    expect(notZip.error).toBe("the file is not a zip archive");
  });

  test("CSV: a header row; numbers and booleans read as such; empty cells left out; quotes", () => {
    expect(parseCsv('name,n,ok,note\n"Ada, L.",3,true,\nBob,-1.5,false,"say ""hi"""\r\n')).toEqual([
      { name: "Ada, L.", n: 3, ok: true },
      { name: "Bob", n: -1.5, ok: false, note: 'say "hi"' },
    ]);
  });

  test("an import waiting for confirmation can be canceled; then it cannot be confirmed", async () => {
    const src = make();
    const w = await importFile(
      src,
      { file: new Blob(["{}"]), format: "jsonLines", mode: "append", table: "tasks" },
      false,
    );
    await src.cancelSnapshotImport(w.id);
    expect((await src.getSnapshotImport(w.id)).state).toBe("failed");
    await expect(src.confirmSnapshotImport(w.id)).rejects.toThrow("not waiting for confirmation");
    expect(await count(src, "tasks")).toBe(6);
  });

  test("each step needs its operation; importing also needs to write", async () => {
    const view = make({ capabilities: { operations: ["viewData", "viewBackups"], readOnly: false } });
    await expect(view.requestSnapshotExport({ includeStorage: false })).rejects.toThrow("cannot request snapshots");
    await expect(view.downloadSnapshotExport("x")).rejects.toThrow("cannot download snapshots");
    const ro = make({ capabilities: { operations: ["viewData", "writeData", "importBackups"], readOnly: true } });
    await expect(
      ro.startSnapshotImport({ file: new Blob(["{}"]), format: "jsonLines", mode: "append", table: "t" }),
    ).rejects.toThrow("cannot write data");
  });
});
