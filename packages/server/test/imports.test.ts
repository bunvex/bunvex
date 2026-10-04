// Snapshot imports (STUDY-42 PR 3), end to end over HTTP: the four formats with Convex's value rules and
// messages, the four modes, the upload protocol and the confirmation summary, `_id`s and table numbers
// kept, `_storage` restored, an import that applies whole or not at all (but appending), cancellation,
// the operation it needs, and an export → import round trip.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, defineTable, Engine, type SchemaDefinition } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { encodeId, toExportJson, type Value, v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { Functions, mutation } from "../src/functions.ts";
import { confirmationMessage, parseCsvCell, renderTableChanges } from "../src/import-parse.ts";
import { createServer } from "../src/server.ts";
import { ZipFileWriter } from "../src/zip-writer.ts";

const SECRET = "57".repeat(32);
const NAME = "import-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const READ_ONLY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), readOnly: true });

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Doc = Record<string, Value>;

/** A blob store whose reads fail while `failRead` says so (a storage outage). */
class FlakyStore extends MemoryBlobStore {
  failRead: (key: string, range?: { start: number; end: number }) => boolean = () => false;
  override async get(key: string, range?: { start: number; end: number }) {
    if (this.failRead(key, range)) throw new Error("storage is unavailable");
    return super.get(key, range);
  }
}

async function setup(schema: SchemaDefinition = defineSchema({})) {
  const engine = await new Engine(schema, await MemoryPersistence.open(null, { durable: false }), {
    instanceName: NAME,
    instanceSecret: SECRET,
  }).init();
  const functions = new Functions(engine).register("m", {
    insert: mutation(async ({ db }, { table, doc }: { table: string; doc: Record<string, unknown> }) =>
      db.insert(table, doc),
    ),
    uploadUrl: mutation(async ({ storage }) => storage.generateUploadUrl()),
  });
  const files = new MemoryBlobStore();
  const uploads = new FlakyStore();
  const s = createServer({
    engine,
    functions,
    port: 0,
    fileStorage: files,
    exportStorage: new MemoryBlobStore(),
    importStorage: uploads,
    importOptions: { retryBackoffMs: { initial: 5, max: 20 } },
  });
  stops.push(() => s.shutdown());
  const api = `http://127.0.0.1:${s.server.port}`;
  const post = (path: string, body: string | Uint8Array | object = {}, key: string | null = KEY) =>
    fetch(`${api}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bunvex ${key}` } : {}),
      },
      body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body),
    });
  /** The one-shot import: its JSON answer and status. */
  const importNow = async (body: string | Uint8Array, query: string) => {
    const res = await post(`/api/import?${query}`, body);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const docs = (table: string) =>
    engine.query(async (db) => (await db.query(table).collect()) as unknown as Doc[]) as Promise<Doc[]>;
  const queryImport = async (importId: string) =>
    (
      (await (
        await post("/api/query", { path: "_system/cli/queryImport", args: { importId }, format: "encoded_json" })
      ).json()) as {
        value: Record<string, unknown> & { state: Record<string, unknown> };
      }
    ).value;
  const waitState = async (importId: string, states: string[]) => {
    for (let i = 0; i < 400; i++) {
      const r = await queryImport(importId);
      if (states.includes(r.state.state as string)) return r;
      await Bun.sleep(25);
    }
    throw new Error("import did not settle");
  };
  /** Convex's CLI upload: start, parts, finish. */
  const upload = async (bytes: Uint8Array, args: Record<string, unknown>, partSize = 7) => {
    const { uploadToken } = (await (await post("/api/import/start_upload")).json()) as { uploadToken: string };
    const partTokens: string[] = [];
    for (let i = 0, n = 1; i < bytes.length; i += partSize, n++) {
      const res = await post(
        `/api/import/upload_part?uploadToken=${encodeURIComponent(uploadToken)}&partNumber=${n}`,
        bytes.subarray(i, i + partSize),
      );
      partTokens.push((await res.json()) as string);
    }
    const res = await post("/api/import/finish_upload", { import: args, uploadToken, partTokens });
    return (await res.json()) as { importId: string };
  };
  return { engine, functions, api, post, importNow, docs, queryImport, waitState, upload, files, uploads };
}

/** A ZIP built as an export builds it. */
async function zipOf(entries: [string, string | Uint8Array][]): Promise<Uint8Array> {
  const d = mkdtempSync(join(tmpdir(), "bunvex-import-"));
  dirs.push(d);
  const w = new ZipFileWriter(join(d, "x.zip"));
  for (const [name, body] of entries) await w.add(name, body);
  await w.finish();
  return new Uint8Array(await Bun.file(w.path).arrayBuffer());
}

const strip = (d: Doc) => {
  const { _id, _creationTime, ...rest } = d;
  return rest;
};

describe("formats and values", () => {
  test("CSV: a header, floats when a cell parses as Rust's f64, else strings", async () => {
    expect(["1", "-2.5", "+3", ".5", "5.", "1e3", "1E-2", "inf", "-Infinity", "NaN"].map(parseCsvCell)).toEqual([
      1,
      -2.5,
      3,
      0.5,
      5,
      1000,
      0.01,
      null,
      null,
      null,
    ]);
    expect(["", " 1", "1 ", "0x10", "1_000", "e5", ".", "abc", "Infinityx"].map(parseCsvCell)).toEqual([
      "",
      " 1",
      "1 ",
      "0x10",
      "1_000",
      "e5",
      ".",
      "abc",
      "Infinityx",
    ]);
    const t = await setup();
    const r = await t.importNow(
      ' name , n ,note\nAda,1,"a, ""quoted""\nline"\r\n\nBob,2.5,\n',
      "format=csv&tableName=people",
    );
    expect(r).toEqual({ status: 200, body: { numWritten: 2 } });
    const people = (await t.docs("people")).map(strip);
    expect(people).toEqual([
      { n: 1, name: "Ada", note: 'a, "quoted"\nline' },
      { n: 2.5, name: "Bob", note: "" },
    ]);
    const short = await t.importNow("a,b\n1,2\n3\n", "format=csv&tableName=short");
    expect(short.body).toEqual({
      code: "ImportFailed",
      message: "Hit an error while importing:\nCSV row 3 doesn't have all of the fields in the header",
    });
    // An empty file imports nothing, as Convex's.
    expect((await t.importNow("", "format=csv&tableName=empty")).body).toEqual({ numWritten: 0 });
  });

  test("JSON Lines and JSON arrays: every number a float64, `$` keys refused, objects only", async () => {
    const t = await setup();
    const r = await t.importNow(
      '{"a":1,"big":9007199254740993,"o":{"x":[1,true,null]}}\n{"a":"s"}\n',
      "format=jsonLines&tableName=lines",
    );
    expect(r.body).toEqual({ numWritten: 2 });
    const [first] = await t.docs("lines");
    expect(typeof first!.a).toBe("number");
    expect(first!.o).toEqual({ x: [1, true, null] });
    const fail = async (body: string, query: string) =>
      ((await t.importNow(body, query)).body.message as string).split("\n")[1];
    expect(await fail('{"$bytes":"AQI="}\n', "format=jsonLines&tableName=b")).toBe(
      "Row 1 wasn't a valid value: Field name $bytes starts with a '$', which is reserved.",
    );
    expect(await fail('{"a":1}\n5\n', "format=jsonLines&tableName=c")).toBe(
      "Row 2 wasn't a valid value: expected object, received 5",
    );
    expect(await fail('{"a":1}\n{oops\n', "format=jsonLines&tableName=d")).toStartWith("Row 2 wasn't valid JSON: ");
    expect(await fail('﻿{"a":1}\n', "format=jsonLines&tableName=e")).toBe(
      "UTF-8 BOM is not supported. Please save your file without BOM.",
    );
    expect((await t.importNow('[{"a":1},{"a":2.5}]', "format=jsonArray&tableName=arr")).body).toEqual({
      numWritten: 2,
    });
    expect(await fail('{"a":1}', "format=jsonArray&tableName=f")).toBe("Not a JSON array");
    expect(await fail("[", "format=jsonArray&tableName=g")).toStartWith("Not valid JSON: ");
    expect(await fail('{"_x":1}\n', "format=jsonLines&tableName=h")).toBe(
      "Field '_x' starts with an underscore, which is only allowed for system fields like '_id'",
    );
    // Nothing of the failed imports was written.
    expect(await t.docs("b")).toEqual([]);
    expect(await t.docs("c")).toEqual([]);
  });

  test("the format arguments, as Convex checks them", async () => {
    const t = await setup();
    expect((await t.importNow("[]", "format=jsonArray")).body).toEqual({
      code: "InvalidName",
      message: "JSON import requires table name",
    });
    expect((await t.importNow("", "format=zip&tableName=x")).body).toEqual({
      code: "InvalidName",
      message: "ZIP import cannot have table name",
    });
    expect((await t.importNow("[]", "format=jsonArray&tableName=bad-name")).body.code).toBe("ImportInvalidName");
    expect((await t.importNow("[]", "format=jsonArray&tableName=x&componentPath=c")).body.code).toBe(
      "ComponentsNotSupported",
    );
  });
});

describe("modes, ids and the summary", () => {
  test("requireEmpty refuses a non-empty table; append adds; replace replaces", async () => {
    const t = await setup();
    await t.functions.runMutation("m:insert", { table: "items", doc: { old: true } });
    expect((await t.importNow('{"a":1}\n', "format=jsonLines&tableName=items")).body.message).toBe(
      "Hit an error while importing:\nTable items already exists. Please choose a new table name or use replace/append modes.",
    );
    await t.importNow('{"a":1}\n', "format=jsonLines&tableName=items&mode=append");
    expect((await t.docs("items")).map(strip)).toEqual([{ old: true }, { a: 1 }]);
    await t.importNow('{"a":2}\n', "format=jsonLines&tableName=items&mode=replace");
    expect((await t.docs("items")).map(strip)).toEqual([{ a: 2 }]);
  });

  test("requireEmpty is checked again when the import runs: a table filled after the summary fails it", async () => {
    const t = await setup();
    const { importId } = await t.upload(new TextEncoder().encode('{"a":1}\n'), {
      tableName: "late",
      format: "jsonLines",
    });
    await t.waitState(importId, ["waiting_for_confirmation"]);
    await t.functions.runMutation("m:insert", { table: "late", doc: { first: true } });
    await t.post("/api/perform_import", { importId });
    const done = await t.waitState(importId, ["completed", "failed"]);
    expect(done.state).toEqual({
      state: "failed",
      error_message:
        "Hit an error while importing:\nTable late already exists. Please choose a new table name or use replace/append modes.",
    });
    expect((await t.docs("late")).map(strip)).toEqual([{ first: true }]);
    // Now that it is not empty, the summary itself fails it: nothing to confirm.
    const again = await t.upload(new TextEncoder().encode('{"a":1}\n'), { tableName: "late", format: "jsonLines" });
    expect((await t.waitState(again.importId, ["waiting_for_confirmation", "failed"])).state.state).toBe("failed");
  });

  test("the upload protocol, Convex's summary and confirmation, then the import", async () => {
    const t = await setup();
    for (let i = 0; i < 1234; i++) await t.functions.runMutation("m:insert", { table: "messages", doc: { i } });
    const body = new TextEncoder().encode('{"text":"a"}\n{"text":"b"}\n');
    const { importId } = await t.upload(body, { tableName: "messages", format: "jsonLines", mode: "replace" });
    const waiting = await t.waitState(importId, ["waiting_for_confirmation", "failed"]);
    expect(waiting.state).toEqual({
      state: "waiting_for_confirmation",
      message_to_confirm: [
        "Import change summary:",
        "table    | create | delete         |",
        "------------------------------------",
        "messages | 2      | 1,234 of 1,234 |",
        "Once the import has started, it will run in the background.",
        "Interrupting `bunvex import` will not cancel it.",
      ].join("\n"),
      require_manual_confirmation: true,
    });
    expect(waiting.mode).toBe("Replace");
    expect(waiting.format).toEqual({ format: "jsonl", table: "messages" });
    expect(waiting.requestor).toEqual({ type: "snapshotImport" });
    expect("object_size" in waiting).toBe(false);
    // Nothing happens before the confirmation.
    expect((await t.docs("messages")).length).toBe(1234);
    expect((await t.post("/api/perform_import", { importId })).status).toBe(200);
    const done = await t.waitState(importId, ["completed", "failed"]);
    expect(done.state.state).toBe("completed");
    expect(done.state.num_rows_written).toEqual({
      $integer: Buffer.from(new BigInt64Array([2n]).buffer).toString("base64"),
    });
    // Each table's checkpoint counts what was written.
    expect((done.checkpoints as { display_table_name: string; num_rows_written: unknown }[])[0]).toMatchObject({
      display_table_name: "messages",
      num_rows_written: { $integer: Buffer.from(new BigInt64Array([2n]).buffer).toString("base64") },
    });
    expect((await t.docs("messages")).map(strip)).toEqual([{ text: "a" }, { text: "b" }]);
    // The replaced table's documents are removed in the background.
    await t.engine.tablesDeleted();
    expect(t.engine.catalog.deleting.size).toBe(0);
  });

  test("the summary's columns pad to the widest cell; no deletes needs no manual confirmation", () => {
    expect(
      renderTableChanges([
        { table: "_storage", added: 10, deleted: 11, existing: 11, unit: " files" },
        { table: "big", added: 100000, deleted: 100000, existing: 100000, unit: "" },
      ]),
    ).toEqual([
      "table    | create  | delete             |",
      "-----------------------------------------",
      "_storage | 10      | 11 of 11 files     |",
      "big      | 100,000 | 100,000 of 100,000 |",
    ]);
    expect(confirmationMessage([])).toBe(
      "Once the import has started, it will run in the background.\nInterrupting `bunvex import` will not cancel it.",
    );
  });

  test("_id kept when its table number matches; a foreign one refused", async () => {
    const t = await setup();
    const id = (await t.functions.runMutation("m:insert", { table: "a", doc: { x: 1 } })) as string;
    // Replace `a` with its own document under the same id and _creationTime.
    const [doc] = await t.docs("a");
    await t.importNow(`${toExportJson({ ...doc!, x: 2 })}\n`, "format=jsonLines&tableName=a&mode=replace");
    expect(await t.docs("a")).toEqual([{ ...doc!, x: 2 }]);
    // An id of `a` in a new table, while `a` stays: Convex's table conflict.
    const c = await t.importNow(`{"_id":"${id}"}\n`, "format=jsonLines&tableName=c");
    expect(c.body.message).toBe(
      "Hit an error while importing:\nNew table `c` has IDs that conflict with existing table `a`. To delete all existing tables, import with `bunvex import --replace-all`.",
    );
    // A table numbered by `_tables` whose documents carry another table's ids: refused as Convex's.
    const zip = await zipOf([
      ["_tables/documents.jsonl", '{"name":"d","id":10050}\n'],
      ["d/documents.jsonl", `{"_id":"${id}"}\n`],
    ]);
    expect((await t.importNow(zip, "format=zip")).body.message).toBe(
      `Hit an error while importing:\n_id ${id} cannot be imported into 'd' because it came from a different deployment and conflict with preexisting tables in this deployment. Try deleting preexisting tables or importing into an empty deployment.`,
    );
  });

  test("schema: documents are checked with the import's tables; a failure leaves nothing behind", async () => {
    const schema = defineSchema({
      users: defineTable({ name: v.string() }),
      posts: defineTable({ author: v.id("users"), title: v.string() }),
    });
    const t = await setup(schema);
    const zip = await zipOf([
      ["_tables/documents.jsonl", '{"name":"users","id":10001}\n{"name":"posts","id":10002}\n'],
      ["users/documents.jsonl", '{"name":"Ada"}\n'],
      ["users/generated_schema.jsonl", '"uniform"\n'],
      ["posts/documents.jsonl", '{"title":5}\n'],
      ["posts/generated_schema.jsonl", '"uniform"\n'],
    ]);
    // Valid: posts point at users, a table that is still hidden while they are checked.
    const good = await zipOf([
      ["_tables/documents.jsonl", '{"name":"users","id":10001}\n{"name":"posts","id":10002}\n'],
      ["users/documents.jsonl", '{"_id":"USER","name":"Ada"}\n'.replace("USER", encodeId(10001, new Uint8Array(16)))],
      ["posts/documents.jsonl", `{"author":"${encodeId(10001, new Uint8Array(16))}","title":"t"}\n`],
    ]);
    expect((await t.importNow(good, "format=zip&mode=replace")).body).toEqual({ numWritten: 2 });
    await t.importNow(new Uint8Array(await zipOf([["_tables/documents.jsonl", ""]])), "format=zip&mode=replaceAll");
    const before = t.engine.catalog.hidden.size;
    const r = await t.importNow(zip, "format=zip&mode=replace");
    expect(r.body.message).toStartWith(
      'Hit an error while importing:\nFailed to insert or update a document in table "posts" because it does not match the schema',
    );
    // `users` was written into a hidden table, which is dropped: nothing visible changed.
    expect(await t.docs("users")).toEqual([]);
    await t.engine.tablesDeleted();
    expect(t.engine.catalog.hidden.size).toBe(before);
    expect(t.engine.catalog.deleting.size).toBe(0);
  });

  test("replaceAll deletes the tables the import does not have", async () => {
    const t = await setup();
    await t.functions.runMutation("m:insert", { table: "keep", doc: { a: 1 } });
    await t.functions.runMutation("m:insert", { table: "gone", doc: { a: 1 } });
    const r = await t.importNow('{"k":2}\n', "format=jsonLines&tableName=keep&mode=replaceAll");
    expect(r.body).toEqual({ numWritten: 1 });
    expect((await t.docs("keep")).map(strip)).toEqual([{ k: 2 }]);
    expect(t.engine.catalog.tables.has("gone")).toBe(false);
  });

  test("append writes the live table: rows of earlier batches stay when a later one fails", async () => {
    const t = await setup();
    await t.functions.runMutation("m:insert", { table: "log", doc: { i: -1 } });
    const lines = Array.from({ length: 8002 }, (_, i) => (i === 8001 ? '{"$bad":1}' : `{"i":${i}}`)).join("\n");
    const r = await t.importNow(`${lines}\n`, "format=jsonLines&tableName=log&mode=append");
    expect(r.status).toBe(400);
    // The first batch (8001 rows) committed; the failing one did not.
    expect((await t.docs("log")).length).toBe(1 + 8001);
  });

  test("a table the schema points to cannot change its number under documents outside the import", async () => {
    const schema = defineSchema({
      users: defineTable({ name: v.string() }),
      posts: defineTable({ author: v.id("users") }),
    });
    const t = await setup(schema);
    const ada = await t.functions.runMutation("m:insert", { table: "users", doc: { name: "Ada" } });
    await t.functions.runMutation("m:insert", { table: "posts", doc: { author: ada } });
    const zip = await zipOf([
      ["_tables/documents.jsonl", '{"name":"users","id":10050}\n'],
      ["users/documents.jsonl", '{"name":"Grace"}\n'],
    ]);
    expect((await t.importNow(zip, "format=zip&mode=replace")).body.message).toBe(
      "Hit an error while importing:\nImport changes table 'users' which is referenced by 'posts' in the schema",
    );
    expect((await t.docs("users")).map(strip)).toEqual([{ name: "Ada" }]);
  });

  test("duplicate _ids in a batch are refused; a forged upload part is refused", async () => {
    const t = await setup();
    await t.functions.runMutation("m:insert", { table: "a", doc: {} });
    const [doc] = await t.docs("a");
    const line = `{"_id":"${doc!._id}"}`;
    expect((await t.importNow(`${line}\n${line}\n`, "format=jsonLines&tableName=a&mode=replace")).body.message).toBe(
      'Hit an error while importing:\nObjects in table "a" have duplicate _id fields',
    );
    const { uploadToken } = (await (await t.post("/api/import/start_upload")).json()) as { uploadToken: string };
    const other = (await (await t.post("/api/import/start_upload")).json()) as { uploadToken: string };
    const part = (await (
      await t.post(`/api/import/upload_part?uploadToken=${other.uploadToken}&partNumber=1`, "{}\n")
    ).json()) as string;
    const res = await t.post("/api/import/finish_upload", {
      import: { tableName: "x", format: "jsonLines" },
      uploadToken,
      partTokens: [part],
    });
    expect(await res.json()).toEqual({
      code: "InvalidUploadToken",
      message: "An upload part token is not valid for this upload.",
    });
  });

  test("cancel: an import waiting for confirmation fails; a finished one cannot be canceled", async () => {
    const t = await setup();
    await t.functions.runMutation("m:insert", { table: "x", doc: {} });
    const { importId } = await t.upload(new TextEncoder().encode("{}\n"), {
      tableName: "x",
      format: "jsonLines",
      mode: "replace",
    });
    await t.waitState(importId, ["waiting_for_confirmation"]);
    expect((await t.post("/api/cancel_import", { importId })).status).toBe(200);
    expect((await t.queryImport(importId)).state).toEqual({ state: "failed", error_message: "Import canceled" });
    expect(await (await t.post("/api/cancel_import", { importId })).json()).toEqual({
      code: "CannotCancelImport",
      message: "Cannot cancel an import that has failed",
    });
    expect(await (await t.post("/api/perform_import", { importId: "nope" })).json()).toEqual({
      code: "InvalidImport",
      message: "invalid import id nope",
    });
  });

  test("ImportBackups: a read-only key cannot import", async () => {
    const t = await setup();
    const res = await t.post("/api/import?format=jsonLines&tableName=x", "{}\n", READ_ONLY);
    expect(res.status).toBe(403);
    expect((await t.post("/api/import/start_upload", {}, READ_ONLY)).status).toBe(403);
  });
});

describe("system errors", () => {
  test("a storage failure is retried, and the next attempt resumes where the last one stopped", async () => {
    const t = await setup();
    const big = Array.from({ length: 8005 }, (_, i) => `{"i":${i}}`).join("\n");
    const zipBytes = await zipOf([
      ["a/documents.jsonl", `${big}\n`],
      ["b/documents.jsonl", '{"b":1}\n'],
    ]);
    // Find where `b`'s bytes start, and fail its read while the import runs (its 2nd read; the 1st is the summary's).
    const { ZipReader } = await import("../src/zip-reader.ts");
    const zr = await ZipReader.open({
      size: zipBytes.length,
      read: async (a, b) => zipBytes.slice(a, b + 1),
      stream: async (a, b) => new Blob([zipBytes.slice(a, b + 1)]).stream(),
    });
    const b = zr.entries.find((e) => e.name === "b/documents.jsonl")!;
    let reads = 0;
    t.uploads.failRead = (_key, range) => range?.start === b.offset && ++reads === 2;
    const r = await t.importNow(zipBytes, "format=zip");
    expect(r.body).toEqual({ numWritten: 8006 });
    expect(reads).toBeGreaterThanOrEqual(3);
    // `a` was written once: its first 8001 rows by the failed attempt, the rest by the next one.
    const a = await t.docs("a");
    expect(a.length).toBe(8005);
    expect(new Set(a.map((d) => d.i)).size).toBe(8005);
    expect(await t.docs("b")).toHaveLength(1);
    // The retry wrote into the same hidden table: none is left over.
    await t.engine.tablesDeleted();
    expect(t.engine.catalog.hidden.size).toBe(0);
  });

  test("a storage failure that lasts fails the import after Convex's retries, leaving nothing", async () => {
    const t = await setup();
    const zipBytes = await zipOf([["a/documents.jsonl", '{"a":1}\n']]);
    const { importId } = await t.upload(zipBytes, { format: "zip" }, 1 << 20);
    await t.waitState(importId, ["waiting_for_confirmation"]);
    let reads = 0;
    t.uploads.failRead = (_key, range) => range !== undefined && ++reads > 0;
    const hiddenBefore = t.engine.catalog.hidden.size;
    await t.post("/api/perform_import", { importId });
    const done = await t.waitState(importId, ["completed", "failed"]);
    expect(done.state).toEqual({
      state: "failed",
      error_message: "Your request couldn't be completed. Try again later.",
    });
    // The first attempt and MAX_SYSTEM_FAILURES retries.
    expect(reads).toBeGreaterThanOrEqual(6);
    await t.engine.tablesDeleted();
    expect(t.engine.catalog.hidden.size).toBe(hiddenBefore);
    expect(t.engine.catalog.tables.has("a")).toBe(false);
  });
});

describe("Convex's ZIPs", () => {
  test("an older Convex export: its legacy schema is fine for an empty table, refused once it has documents", async () => {
    const t = await setup();
    // The layout of a 2024 Convex export of an empty `messages` table (convex-backend's demos/cron-jobs/test.zip).
    const empty = await zipOf([
      ["README.md", "# Welcome to your snapshot export!\n"],
      ["_tables/documents.jsonl", '{"name":"messages","id":10001}\n'],
      ["messages/generated_schema.jsonl", '"never"\n'],
      ["messages/documents.jsonl", ""],
    ]);
    expect((await t.importNow(empty, "format=zip")).body).toEqual({ numWritten: 0 });
    expect(t.engine.catalog.tables.get("messages")!.number).toBe(10001);
    const legacy = await zipOf([
      ["users/documents.jsonl", '{"name":"Ada"}\n'],
      ["users/generated_schema.jsonl", '"{name: string}"\n'],
    ]);
    expect((await t.importNow(legacy, "format=zip")).body.message).toBe(
      'Hit an error while importing:\ncannot parse users/generated_schema.jsonl: only the "uniform" encoding of current snapshot exports can be imported',
    );
  });
});

describe("a Convex ZIP with files", () => {
  test("its `_storage` ids carry Convex's fixed number (540): the files import, and file storage keeps working", async () => {
    const t = await setup();
    // As a Convex export lays it out: `_storage/documents.jsonl`, then each file named by its id.
    const fileId = encodeId(540, new Uint8Array(16).fill(7));
    const user = encodeId(10001, new Uint8Array(16).fill(1));
    const sha = new Bun.CryptoHasher("sha256").update("hi there").digest("base64");
    const zip = await zipOf([
      ["README.md", "readme\n"],
      ["_tables/documents.jsonl", '{"name":"users","id":10001}\n'],
      [
        "users/documents.jsonl",
        `{"_creationTime":1700000000000.5,"_id":"${user}","avatar":"${fileId}","name":"Ada"}\n`,
      ],
      ["users/generated_schema.jsonl", '"uniform"\n'],
      [
        "_storage/documents.jsonl",
        `{"_id":"${fileId}","_creationTime":1700000000000.25,"sha256":"${sha}","size":8,"contentType":"text/plain","internalId":"0b0f2c46-9d5c-4e2a-8f3a-3c1a2b4c5d6e"}\n`,
      ],
      [`_storage/${fileId}.txt`, "hi there"],
    ]);
    expect((await t.importNow(zip, "format=zip")).body).toEqual({ numWritten: 1 });
    expect(t.engine.catalog.tables.get("_storage")!.number).toBe(540);
    const [file] = (await t.engine.query((db) => db.asSystem(() => db.query("_storage").collect()))) as Doc[];
    expect(file).toMatchObject({
      _id: fileId,
      _creationTime: 1700000000000.25,
      storageId: "0b0f2c46-9d5c-4e2a-8f3a-3c1a2b4c5d6e",
      sha256: sha,
      size: 8,
      contentType: "text/plain",
    });
    // Served by its URL, and new uploads still work.
    const served = await fetch(`${t.api}/api/storage/0b0f2c46-9d5c-4e2a-8f3a-3c1a2b4c5d6e`);
    expect(await served.text()).toBe("hi there");
    const url = (await t.functions.runMutation("m:uploadUrl", {})) as string;
    const up = (await (await fetch(url, { method: "POST", body: "more" })).json()) as { storageId: string };
    expect(up.storageId.length).toBeGreaterThan(0);
    expect((await t.docs("users"))[0]!.avatar).toBe(fileId);
  });
});

describe("round trip", () => {
  test("export → import into an empty deployment: the same documents, ids, numbers and files", async () => {
    const src = await setup();
    const url = (await src.functions.runMutation("m:uploadUrl", {})) as string;
    const { storageId } = (await (
      await fetch(url, { method: "POST", body: "hello", headers: { "content-type": "text/plain" } })
    ).json()) as { storageId: string };
    const ada = await src.functions.runMutation("m:insert", { table: "users", doc: { name: "Ada" } });
    await src.functions.runMutation("m:insert", {
      table: "posts",
      doc: {
        author: ada,
        n: 3n,
        f: 3,
        neg: -0,
        nan: Number.NaN,
        bytes: new Uint8Array([1, 2]).buffer,
        nested: { list: [1n, 2.5, "s", null] },
        file: storageId,
      },
    });
    await src.post("/api/export/request/zip?includeStorage=true");
    let latest: Record<string, unknown> | null = null;
    for (let i = 0; i < 400 && latest?.state !== "completed"; i++) {
      await Bun.sleep(25);
      latest = (
        (await (
          await src.post("/api/query", {
            path: "_system/cli/exports:getLatest",
            args: {},
            format: "encoded_json",
          })
        ).json()) as {
          value: Record<string, unknown> | null;
        }
      ).value;
    }
    const ts = Buffer.from((latest!.start_ts as { $integer: string }).$integer, "base64").readBigInt64LE();
    const zip = new Uint8Array(
      await (
        await fetch(`${src.api}/api/export/zip/${ts}`, { headers: { authorization: `Bunvex ${KEY}` } })
      ).arrayBuffer(),
    );

    const dst = await setup();
    // A table the source does not have, so the destination's numbers differ from the source's.
    await dst.functions.runMutation("m:insert", { table: "other", doc: {} });
    const { importId } = await dst.upload(zip, { format: "zip", mode: "replaceAll" }, 64 * 1024);
    const waiting = await dst.waitState(importId, ["waiting_for_confirmation", "failed"]);
    expect(waiting.state.message_to_confirm).toBe(
      [
        "Import change summary:",
        "table    | create | delete       |",
        "----------------------------------",
        "_storage | 1      | 0 of 0 files |",
        "other    | 0      | 1 of 1       |",
        "posts    | 1      | 0 of 0       |",
        "users    | 1      | 0 of 0       |",
        "Once the import has started, it will run in the background.",
        "Interrupting `bunvex import` will not cancel it.",
      ].join("\n"),
    );
    await dst.post("/api/perform_import", { importId });
    const done = await dst.waitState(importId, ["completed", "failed"]);
    expect(done.state.state).toBe("completed");
    for (const table of ["users", "posts"]) {
      expect(await dst.docs(table)).toEqual(await src.docs(table));
      expect(dst.engine.catalog.tables.get(table)!.number).toBe(src.engine.catalog.tables.get(table)!.number);
    }
    expect(dst.engine.catalog.tables.has("other")).toBe(false);
    // The file: the same id and storage UUID, the same bytes.
    const [srcFile] = (await src.engine.query((db) => db.asSystem(() => db.query("_storage").collect()))) as Doc[];
    const [dstFile] = (await dst.engine.query((db) => db.asSystem(() => db.query("_storage").collect()))) as Doc[];
    expect({ ...dstFile!, storageKey: null }).toEqual({ ...srcFile!, storageKey: null });
    expect(await new Response(await dst.files.get(dstFile!.storageKey as string)).text()).toBe("hello");
  });
});

test("the import service's cleanup drops hidden tables older than twice the import age limit", async () => {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false }), {
    instanceName: NAME,
    instanceSecret: SECRET,
  }).init();
  const { ImportService, MAX_IMPORT_AGE_MS } = await import("../src/imports.ts");
  let now = Date.now();
  const service = new ImportService(engine, new MemoryBlobStore(), null, { now: () => now });
  await engine.createHiddenTable("orphan");
  expect(await service.cleanup()).toBe(0);
  // Past the import age limit, but not twice it: kept.
  now += MAX_IMPORT_AGE_MS + 1000;
  expect(await service.cleanup()).toBe(0);
  now += MAX_IMPORT_AGE_MS;
  expect(await service.cleanup()).toBe(1);
  await engine.tablesDeleted();
  expect(engine.catalog.hidden.size).toBe(0);
  await engine.close();
});
